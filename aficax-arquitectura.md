# Aficax — Especificación de Arquitectura Completa

> Documento de diseño exhaustivo para construir un agente de IA para desarrollo de software desde cero.
> Basado en análisis de Claude Code (v2.1.88, ~512K LOC), OpenCode (v1.2.6), Codex CLI (Rust rewrite), Aider, y otros.

---

## Índice

1. Filosofía de diseño
2. Estructura de capas
3. El loop del agente
4. Sistema de herramientas (Tools)
5. Gestión de contexto y tokens
6. Sistema de memoria
7. Sistema de permisos y seguridad
8. Sandboxing y ejecución
9. Hooks y ciclo de vida
10. MCP (Model Context Protocol)
11. Conexión a APIs de IA (cloud)
12. Conexión a IA local
13. Multi-agente y sub-agentes
14. Sesiones y persistencia
15. Configuración multicapa
16. Skills (habilidades reutilizables)
17. Interfaz CLI y TUI
18. Menú y comandos slash
19. Indexación de repositorio
20. Sistema de diff y edición de archivos
21. Telemetría y observabilidad
22. Optimización y rendimiento
23. Personalización
24. Seguridad general
25. Estructura de archivos del proyecto

---

## 1. Filosofía de diseño

### Principio central
El 98.4% de la complejidad de un agente está en la infraestructura determinista, no en la IA. El loop del agente es un simple while-loop; la ingeniería real está en permisos, gestión de contexto, enrutamiento de herramientas y recuperación de errores.

### Cinco valores que guían cada decisión de diseño

- **Autoridad humana**: el usuario siempre puede interrumpir, revertir y redirigir
- **Seguridad**: ninguna acción peligrosa se ejecuta sin validación explícita
- **Ejecución confiable**: el agente se recupera de fallos sin perder estado
- **Amplificación de capacidad**: el agente hace cosas que el humano no puede hacer solo
- **Adaptabilidad contextual**: el comportamiento se ajusta al proyecto y al usuario

### Postura arquitectónica
- El agente es un harness alrededor de un modelo de lenguaje, no el modelo mismo
- Toda capacidad se expone como una herramienta con interfaz uniforme
- Las políticas de seguridad se implementan en código, no en prompts
- La separación entre lógica de presentación, aplicación, dominio e infraestructura es estricta

---

## 2. Estructura de capas

### Capa 1: Presentación
Responsable exclusivamente de renderizar la TUI y capturar input. No conoce nada de llamadas API ni ejecución de herramientas. Interactúa únicamente con la capa de aplicación.

Componentes:
- Renderer TUI (terminal UI)
- Input handler (teclado, shortcuts)
- Streaming output display
- Diff viewer integrado
- Progress indicators
- Approval prompts
- Error display

### Capa 2: Aplicación
Orquesta el flujo completo. Es la única capa que conoce el estado global de la sesión.

Componentes:
- QueryEngine (núcleo del loop)
- Command router (slash commands)
- Hook dispatcher
- Session manager
- Permission orchestrator

### Capa 3: Dominio
Define las abstracciones centrales. No conoce I/O ni detalles de implementación.

Componentes:
- Definición de Tool (interfaz uniforme)
- AppState (estado de la aplicación)
- Permission model (modelo de permisos)
- Message schema (estructura de mensajes)
- Session schema

### Capa 4: Infraestructura
Maneja todo el I/O real.

Componentes:
- API clients (Anthropic, OpenAI, Ollama, LM Studio, etc.)
- File system I/O
- SQLite persistence (sesiones, historial)
- MCP client/server
- Telemetría y analytics
- Git integration

---

## 3. El loop del agente

### Descripción general
El loop es la pieza más crítica. Es un generador asíncrono que coordina: input del usuario → construcción del sistema de prompt → llamada API → streaming de respuesta → ejecución de herramientas → feed de resultados → repetir.

### Fases del loop (tres fases, no lineales)

**Fase 1: Gather context**
- Leer archivos relevantes
- Ejecutar búsquedas en el repositorio
- Cargar memoria y AFICAX.md
- Calcular estado git
- Consultar estado de MCP servers activos

**Fase 2: Take action**
- Editar archivos (write, edit, multiedit)
- Ejecutar comandos bash
- Llamar herramientas externas vía MCP
- Spawn sub-agentes para tareas paralelas

**Fase 3: Verify results**
- Ejecutar tests
- Leer outputs de comandos
- Evaluar si la tarea está completa
- Decidir si reintentar o terminar

### Estructura interna del loop

```
while task_not_complete:
    1. Antes de cada API call:
       a. Evaluar presupuesto de tokens (token_budget)
       b. Ejecutar compactación si se supera el umbral
       c. Construir system prompt completo desde fuentes en orden
       d. Ejecutar hooks PreAPICall si existen

    2. API call (streaming):
       a. Enviar mensajes + herramientas disponibles + system prompt
       b. Recibir stream de tokens
       c. Detectar bloques tool_use en el stream

    3. Si hay tool_calls:
       a. Validar permisos de cada tool
       b. Ejecutar hook PreToolUse
       c. Ejecutar la herramienta
       d. Ejecutar hook PostToolUse
       e. Appender tool_result a la conversación
       f. Volver al paso 1

    4. Si no hay tool_calls:
       a. Extraer texto de respuesta
       b. Mostrar al usuario
       c. Esperar input del usuario o terminar

    5. Manejo de errores en API call:
       a. Error 413 (prompt too long): intentar compactación más agresiva
       b. Error de output tokens: truncar output
       c. Error de red: reintentar con backoff exponencial
       d. Model fallback: insertar tombstone en historial y cambiar modelo
```

### Terminación del loop
- El modelo emite un mensaje de texto sin tool_calls → control vuelve al usuario
- El usuario interrumpe (Ctrl+C) → checkpoint del estado actual
- Se alcanza max_turns configurado
- Error irrecuperable después de N reintentos

### Primitivas de control del loop (composables)
Basado en análisis académico de 13 agentes, los loops se construyen combinando:

- **ReAct**: razonar → actuar → observar → repetir (el más común)
- **generate-test-repair**: generar código → ejecutar tests → reparar si falla
- **plan-execute**: fase de planificación sin acción → fase de ejecución
- **multi-attempt retry**: reintentar con estrategia diferente si falla
- **tree search**: explorar múltiples caminos y seleccionar el mejor

Aficax debe soportar al menos ReAct, generate-test-repair y plan-execute como modos configurables.

---

## 4. Sistema de herramientas (Tools)

### Interfaz uniforme de Tool
Cada herramienta implementa el mismo contrato:
- `name`: identificador único
- `description`: descripción para el modelo (crítico para que el modelo la use correctamente)
- `input_schema`: JSON Schema del input
- `execute(input) → result`: función de ejecución
- `permission_level`: clasificación de riesgo
- `requires_approval`: booleano o función que evalúa el input

### Categorías de herramientas

**READ (lectura, bajo riesgo)**
- `read_file`: leer contenido de un archivo
- `list_directory`: listar archivos y carpetas
- `glob`: buscar archivos por patrón
- `grep`: buscar texto dentro de archivos (internamente usa ripgrep para velocidad)
- `git_status`: estado actual del repositorio
- `git_log`: historial de commits
- `git_diff`: diferencias entre commits o con working directory

**WRITE (escritura, riesgo medio)**
- `write_file`: crear o sobreescribir un archivo completo
- `edit_file`: editar porciones específicas usando formato search/replace o diff
- `multi_edit`: editar múltiples archivos en una sola operación atómica
- `delete_file`: eliminar un archivo (requiere aprobación)
- `create_directory`: crear directorio

**EXECUTE (ejecución, alto riesgo)**
- `bash`: ejecutar comando arbitrario en shell
- `spawn_agent`: crear un sub-agente con tarea delegada
- `python_repl`: REPL de Python opcional para evaluación de código

**WEB**
- `web_search`: buscar en internet
- `web_fetch`: obtener contenido de una URL

**WORKFLOW**
- `todo_write`: escribir y actualizar lista de tareas del agente
- `todo_read`: leer lista de tareas actual
- `ask_user`: solicitar input al usuario de forma explícita (pausa el loop)

**MCP (externas)**
Cada MCP server registrado expone sus herramientas y se insertan en el registro como herramientas de primera clase, idénticas a las built-in.

### Registro de herramientas
- **Siempre activas**: herramientas core (read, write, bash, todo, web)
- **Condicionalmente activas**: según entorno (PowerShell solo en Windows, LSP si está configurado)
- **Feature-flagged**: herramientas en desarrollo sin exponer en producción
- **MCP-activas**: se registran dinámicamente al conectar un MCP server; se recomputan cada turno porque servers pueden conectar/desconectar

### Naming y descripción de herramientas
La descripción de cada herramienta es el componente más crítico para que el modelo la seleccione correctamente. Debe incluir:
- Qué hace exactamente
- Cuándo usarla vs cuándo NO usarla
- Formato de input esperado
- Qué devuelve

---

## 5. Gestión de contexto y tokens

### El problema
El contexto crece linealmente con cada turno. A 32K tokens, la performance del modelo cae 50-70% en tareas complejas. A 100K+ tokens, la degradación es severa. La gestión de contexto es el problema de infraestructura más importante de un agente.

### Estrategia de token budget
- Mantener un presupuesto activo de tokens en cada turno
- Calcular tokens usados antes de cada API call
- Reservar buffer de seguridad (mínimo 13K tokens) para output del modelo
- Disparar compactación antes de que se agote el presupuesto

### Tres niveles de compactación (sistema en cascada)

**Nivel 1 — MicroCompact (costo cero)**
- Edición local sin llamada API
- Truncar outputs viejos de herramientas en el historial
- Eliminar repeticiones y mensajes intermedios de baja información
- Disparar primero siempre

**Nivel 2 — AutoCompact (costo bajo)**
- Se dispara cuando el contexto supera el umbral configurado
- Genera un resumen estructurado de la sesión (hasta 20K tokens) via API
- El resumen reemplaza el historial comprimido
- Tiene un circuit breaker: después de 3 fallos consecutivos, no reintenta
- Post-compactación: el presupuesto de tokens activos se resetea a 50K

**Nivel 3 — FullCompact (costo alto)**
- Comprime la conversación completa
- Re-inyecta archivos accedidos recientemente (máximo 5K tokens por archivo)
- Re-inyecta planes activos y schemas de skills relevantes
- Solo se ejecuta cuando MicroCompact y AutoCompact son insuficientes

### Construcción del system prompt (orden estricto)
El system prompt se construye en cada API call desde múltiples fuentes, en este orden de prioridad:

1. Instrucciones base del agente + reglas de seguridad (zona estática, cacheable globalmente)
2. AFICAX.md global del usuario (~/.aficax/AFICAX.md)
3. AFICAX.md del proyecto (raíz del repo)
4. AFICAX.md del directorio actual (si difiere del raíz)
5. Memoria automática cargada (máximo configurado, ej. primeras 200 líneas o 25KB)
6. Estado del directorio de trabajo + git status
7. Capacidades de MCP servers activos (siempre recomputado, sin caché)
8. Instrucciones de modo actual (plan mode, auto mode, etc.)

### Zona de caché (prompt caching)
- **Zona estática**: instrucciones base + AFICAX.md global → `cacheScope: global` (compartido entre todos los usuarios del mismo proyecto)
- **Zona dinámica**: estado git, capacidades MCP, memoria de sesión → sin caché (cambia cada turno)
- Las instrucciones de MCP están explícitamente sin caché porque servers pueden conectar/desconectar entre turnos

### Estrategias de context engineering
- Indexación por relevancia: no meter todo el repo, solo archivos relevantes a la tarea
- Context offloading: mover información que no necesita el modelo a storage, traerla solo si se solicita
- Sub-agente isolation: cada sub-agente tiene su propio context window; no puede leer el contexto del padre
- Acceso a archivos on-demand: el modelo pide leer archivos específicos cuando los necesita; no se cargan todos al inicio

---

## 6. Sistema de memoria

### Tipos de memoria

**Memoria en sesión (working memory)**
- Conversación activa en el context window
- Estado del loop actual (tareas pendientes, archivos editados)
- Se pierde al terminar la sesión si no se persiste

**Memoria de proyecto (AFICAX.md)**
- Archivo Markdown por proyecto
- El usuario y el agente lo editan
- Se carga automáticamente al inicio de cada sesión
- Contiene: convenciones del proyecto, arquitectura, restricciones, preferencias
- Estructura jerárquica: global → proyecto → directorio (cada nivel sobrescribe al anterior en conflictos)

**Memoria automática (auto-memory)**
- El agente extrae aprendizajes de cada sesión y los guarda
- Patrones del proyecto, preferencias del usuario, decisiones tomadas
- Se inyecta al inicio de la sesión siguiente (limitado a N líneas o K bytes)
- El usuario puede revisar, editar y eliminar entradas

**Memoria de largo plazo (MEMORY.md)**
- Archivo separado de AFICAX.md
- Para preferencias personales y configuraciones que aplican a todos los proyectos
- Se carga al inicio de cada sesión (primeras 200 líneas o 25KB, lo que sea menor)

**Historial de sesiones**
- Almacenado como JSONL append-only
- Nunca se edita destructivamente; las compactaciones agregan marcadores
- Soporte para resume, rewind y fork de sesiones

### Persistencia de memoria
- SQLite para datos estructurados (sesiones, mensajes, metadatos)
- JSON files para configuración y estado rápido de lectura
- JSONL para transcripts (append-only, inmutable)
- Checkpoints de archivos para rewind: almacenados en ~/.aficax/file-history/<sessionId>/

---

## 7. Sistema de permisos y seguridad

### Modelo de permisos en cascada (de mayor a menor precedencia)

1. **Reglas de configuración** (settings.json, AFICAX.md): política base del proyecto
2. **Lógica de la herramienta**: validación interna específica a cada tool
3. **Modo activo**: read-only, auto, full-access, plan-only
4. **Clasificador de riesgo**: evalúa el comando concreto a ejecutar
5. **Decisión del usuario**: aprobación o rechazo manual (último recurso)

### Clasificaciones de operación

**Auto-approve (sin prompt al usuario)**
- Leer archivos dentro del workspace
- Búsquedas de texto
- Comandos git de lectura (status, log, diff)
- Listar directorios

**Require approval (prompt al usuario)**
- Escribir o modificar archivos
- Ejecutar comandos bash (primer uso de cada comando nuevo)
- Acceder a dominios de red nuevos
- Operaciones git de escritura (commit, push, checkout)

**Always deny (bloqueo incondicional)**
- Acceder a rutas fuera del workspace sin aprobación explícita
- Escribir en archivos de configuración del sistema
- Operaciones que podrían establecer persistencia (cron, systemd, startup scripts)
- Acceder a credenciales y secretos (SSH keys, .env, tokens)

### Modos de operación
Seleccionable por el usuario al iniciar o con comando slash:

- **plan**: solo lectura y planificación, cero acciones
- **read-only**: lectura + búsqueda, sin escritura ni ejecución
- **auto**: escritura dentro del workspace permitida; fuera requiere aprobación
- **full**: acceso completo con aprobación solo para operaciones críticas
- **headless / ci**: modo no-interactivo para pipelines CI/CD; require configuración previa explícita de qué está permitido

### Allowlist y denylist
- Allowlist permanente: comandos aprobados por el usuario se guardan en config para no preguntar de nuevo
- Denylist permanente: comandos que el usuario ha rechazado; se bloquean automáticamente en futuras sesiones
- Ambas persistidas en settings.json por proyecto y globalmente en ~/.aficax/

### Detección de patrones peligrosos
Lista de patrones de comandos que siempre requieren revisión especial, independientemente del modo:
- `rm -rf`, `dd`, `mkfs`, `format`
- `chmod 777`, `chown`
- Acceso a rutas de credenciales: `~/.ssh/`, `~/.aws/`, `.env`
- Comandos de red: `curl | bash`, `wget | sh`
- Instalación de software: `npm install -g`, `pip install` (fuera del proyecto)
- Modificación de git hooks del repo

### Tombstones en historial
Cuando se cambia de modelo mid-sesión o un tool_call queda sin resultado, se inserta un tombstone (marcador) en el historial para mantener consistencia interna. Evita que el modelo vea un historial inconsistente.

---

## 8. Sandboxing y ejecución

### Niveles de aislamiento (de menor a mayor costo)

**Nivel 0: Sin sandbox**
- Ejecución directa en el host
- Solo apropiado para tareas de solo lectura o con allowlist muy restrictiva
- No recomendado para bash arbitrario

**Nivel 1: Restricciones del sistema operativo**
- Linux: bubblewrap (bwrap) + seccomp para filtrar syscalls
- macOS: sandbox-exec con policy files por capas
- Windows: restricted tokens + private desktop (Winsta0\Default isolation)
- Landlock para restricciones de filesystem a nivel de kernel
- Bajo overhead; no requiere virtualización

**Nivel 2: Contenedor**
- Docker o Podman con filesystem montado de solo lectura excepto workspace
- Network policies para bloquear egress no autorizado
- Compartir el kernel del host (menos seguro que VM, mayor compatibilidad)

**Nivel 3: MicroVM**
- KVM (Linux) o Virtualization.framework (macOS)
- Kernel propio → barrera real contra kernel escapes
- Proyectos como microsandbox, Kata Containers
- Mayor overhead de arranque (100ms-2s según implementación)
- Máxima seguridad; recomendado para CI y ejecución no supervisada

### Políticas de sandbox para Aficax

**Filesystem**
- Escritura permitida: solo dentro del workspace activo
- Lectura permitida: workspace + rutas explícitamente allowlisteadas
- Escritura bloqueada siempre: dotfiles, directorios de configuración del sistema, credenciales

**Red**
- Por defecto: bloquear todo egress
- Permitir: dominios explícitamente aprobados por el usuario por sesión
- Logging de cada solicitud de red

**Procesos**
- Límite de procesos hijos
- Timeout por comando
- CPU y memoria máximos por ejecución

### Modo proxy de red controlado
Para tools que necesitan acceso a internet:
- Proxy interno que intercepta todas las solicitudes
- Primer acceso a un dominio nuevo → prompt al usuario para aprobar o denegar
- Dominios aprobados → allowlist de sesión
- Bloqueo de AF_UNIX y socketpair nuevos post-inicio para prevenir escape

---

## 9. Hooks y ciclo de vida

### Qué son los hooks
Scripts o funciones que se ejecutan en puntos específicos del ciclo de vida del agente. Permiten al usuario controlar, filtrar, auditar y extender el comportamiento del agente sin modificar su código core.

### Hooks disponibles

**PreAPICall**
- Se ejecuta antes de cada llamada al modelo
- Puede modificar el system prompt o los mensajes
- Caso de uso: inyección automática de contexto adicional, policies de empresa

**PostAPICall**
- Se ejecuta después de recibir la respuesta del modelo
- Puede inspeccionar la respuesta antes de procesarla
- Caso de uso: logging, compliance, filtrado de output

**PreToolUse**
- Se ejecuta antes de ejecutar cualquier herramienta
- Puede BLOQUEAR la ejecución (retorna error al modelo)
- Puede modificar el input de la herramienta
- Caso de uso: bloquear comandos peligrosos, sanitizar paths, auditoría

**PostToolUse**
- Se ejecuta después de que la herramienta retorna
- Puede modificar el resultado antes de que el modelo lo vea
- Caso de uso: redactar secretos del output, logging detallado

**PreUserPromptSubmit**
- Se ejecuta antes de que el input del usuario llegue al modelo
- Puede modificar o rechazar el input
- Caso de uso: inyección de contexto de empresa, content policy

**OnSessionStart**
- Al inicio de cada sesión
- Caso de uso: cargar configuración dinámica, validar credenciales, notificaciones

**OnSessionEnd**
- Al terminar cada sesión
- Caso de uso: generar resumen, guardar métricas, limpiar archivos temporales

**OnError**
- Cuando el loop encuentra un error irrecuperable
- Caso de uso: alertas, logging de incidentes, limpieza

### Configuración de hooks
Los hooks se definen en `.aficax/hooks.json` por proyecto o globalmente en `~/.aficax/hooks.json`. Cada hook especifica:
- Evento al que responde
- Comando o script a ejecutar (recibe el contexto como JSON por stdin)
- Timeout máximo de ejecución
- Comportamiento si el hook falla (fail-open o fail-closed)

### Seguridad de hooks
- Los hooks se ejecutan con los mismos permisos del proceso del agente
- Los hooks en repositorios clonados pueden ser maliciosos: deben validarse antes de activarse
- Opción de sandboxear los hooks igual que los comandos bash
- Logging completo de cada ejecución de hook

---

## 10. MCP (Model Context Protocol)

### Qué es MCP
Protocolo estándar (Anthropic, 2024) para que agentes se conecten a servicios externos. Un MCP server expone herramientas, recursos y prompts que el agente puede usar como si fueran built-in.

### Tipos de MCP servers soportados
- **STDIO**: proceso local que se comunica por stdin/stdout
- **Streaming HTTP (SSE)**: servidor remoto que usa Server-Sent Events
- **WebSocket**: para comunicación bidireccional persistente

### Ciclo de vida de MCP en Aficax

1. Al inicio de sesión: conectar todos los MCP servers configurados
2. Descubrir herramientas disponibles via llamada `tools/list`
3. Registrar herramientas en el registry local de Aficax
4. Recomputar lista de capacidades disponibles antes de cada API call (servers pueden desconectarse entre turnos)
5. Al usar una herramienta MCP: forwarding transparente al server
6. Al terminar sesión: desconectar todos los servers activos

### Configuración de MCP
En `.aficax/mcp.json` o en la configuración global:
```
nombre del server → tipo (stdio/http) → comando o URL → variables de entorno → autenticación
```

Múltiples servers pueden estar activos simultáneamente. Las herramientas de distintos servers se namespaced para evitar colisiones.

### Aficax como MCP server
El propio Aficax puede exponerse como MCP server para ser usado por otros agentes o IDEs. Esto permite integrarlo en herramientas que ya soportan MCP (Claude Desktop, Cursor, Windsurf, etc.).

### Autenticación en MCP
- OAuth 2.0 para servers remotos
- Variables de entorno para tokens/API keys
- Credenciales nunca expuestas al modelo en el context window

### Herramientas MCP en el contexto
Las instrucciones de MCP servers se incluyen en el system prompt pero en la zona sin caché, porque los servers conectados pueden cambiar entre turnos.

---

## 11. Conexión a APIs de IA (cloud)

### Diseño de provider-agnostic
Aficax no debe estar acoplado a un solo proveedor. La capa de provider implementa una interfaz común que abstrae las diferencias entre APIs.

### Interfaz común de provider
- `complete(messages, tools, stream) → stream de tokens`
- `count_tokens(messages) → int`
- `get_model_info(model_id) → {context_window, max_output, supports_tools}`
- `normalize_tool_schema(tools) → formato específico del provider`

### Providers soportados
Cada provider tiene un adaptador que normaliza su API al formato común:

**Anthropic**
- Modelos: Claude Opus, Sonnet, Haiku (familia 4+)
- API: Messages API con streaming
- Tool calling: formato nativo de Anthropic
- Extended thinking: soporte para thinking budgets
- Prompt caching: soporte para cacheScope global

**OpenAI**
- Modelos: GPT-5.x, GPT-5.x-Codex, o3, o4
- API: Responses API (preferida para agents) o Chat Completions
- Tool calling: formato JSON Schema estándar

**Google**
- Modelos: Gemini 2.5 Pro, Gemini 2.0 Flash
- API: Generative Language API o Vertex AI
- Contexto de hasta 1M tokens

**Mistral / Groq / Together / Fireworks**
- API OpenAI-compatible; el adaptador de OpenAI funciona con URL personalizada

**Cohere**
- API propia con tool calling

**Azure OpenAI**
- Endpoint configurable; autenticación con managed identity o API key

### Configuración de provider
```
model_id → provider → api_key (desde variable de entorno, nunca hardcoded) → base_url (para endpoints custom) → parámetros (temperatura, max_tokens, reasoning_effort)
```

### Small model para tareas auxiliares
Seleccionar un modelo más ligero y barato para tareas que no requieren razonamiento complejo:
- Generación de títulos de sesión
- Extracción de aprendizajes para memoria automática
- Clasificación de riesgo de comandos simples

Configurable via `small_model` en settings.

### Prompt caching
Cuando el provider lo soporta (Anthropic principalmente):
- Marcar la zona estática del system prompt para caché global
- Reducción de costo y latencia en llamadas repetidas con el mismo contexto base

### Manejo de errores de API

**Error 413 (prompt too long)**
- Intento 1: MicroCompact (sin costo)
- Intento 2: AutoCompact (bajo costo)
- Intento 3: FullCompact (alto costo)
- Si todos fallan: notificar al usuario

**Error de max output tokens**
- Truncar output y continuar

**Error de red / timeout**
- Backoff exponencial con jitter
- N reintentos configurables antes de fallar

**Model fallback**
- Si el modelo principal falla, intentar con modelo de fallback configurado
- Insertar tombstone en historial para mantener consistencia
- Notificar al usuario del cambio de modelo

**Rate limiting**
- Respetar headers Retry-After
- Queue de requests con throttling automático

---

## 12. Conexión a IA local

### Objetivo
Cero dependencia de cloud. Aficax debe funcionar 100% offline con modelos locales.

### Backends de inferencia local soportados

**Ollama**
- API OpenAI-compatible en localhost:11434
- Detección automática de modelos instalados
- Pull de modelos via API de Ollama

**LM Studio**
- API OpenAI-compatible en localhost:1234 (configurable)
- Soporte para modelos GGUF
- GPU/CPU offload configurable

**llama.cpp server**
- Modo servidor HTTP de llama.cpp
- Control granular de layers en GPU

**Llamafile**
- Ejecutable standalone
- Aficax puede spawnearlo y cerrarlo automáticamente

**vLLM**
- Para deployments con múltiples GPUs
- API OpenAI-compatible

**Unsloth Studio**
- Para modelos cuantizados con optimizaciones específicas

### Configuración para inferencia local
```
provider: local
backend: ollama | lm_studio | llamacpp | llamafile | vllm
base_url: http://localhost:PORT/v1
model: nombre-del-modelo-o-ruta-al-GGUF
context_window: (declarado manualmente, no auto-detectado en todos los backends)
gpu_layers: auto | N (número de capas en GPU)
n_ctx: tamaño de ventana de contexto
```

### Detección automática
- Aficax puede escanear puertos comunes (11434, 1234, 8080) al arrancar para detectar backends activos
- Listar modelos disponibles via API del backend
- Mostrar VRAM disponible y recomendar cuantizaciones apropiadas

### Limitaciones con modelos locales
- Tool calling: no todos los modelos locales lo soportan; Aficax debe detectar si el modelo lo soporta y degradar gracefully
- Contexto: declarar el context_window manualmente si el backend no lo reporta
- Velocidad de prefill: con capas en CPU la prefill es muy lenta; recomendar al usuario estrategias para reducir el system prompt

### Hybrid mode
- Modelo local para la mayoría de tareas
- Modelo cloud para tareas que requieren mayor razonamiento (configurable por tipo de task)

---

## 13. Multi-agente y sub-agentes

### Cuándo usar sub-agentes
- Tareas paralelas independientes (ej: refactorizar múltiples módulos simultáneamente)
- Tareas que requieren contextos completamente diferentes
- Reducir el context window del agente principal delegando trabajo específico
- Tareas de verificación/evaluación separadas del agente que genera

### Herramientas de multi-agente

**spawn_agent**
- Crea un sub-agente con tarea específica
- El sub-agente hereda la configuración del padre (provider, approval policy, sandbox)
- Pero tiene su propio context window completamente aislado
- El padre no puede leer el contexto del sub-agente (aislamiento por diseño)
- Parámetros: task, tools_allowed, tools_denied, model, max_turns, permission_mode

**send_input**
- Enviar mensajes a un sub-agente en ejecución (si está en modo interactivo)

**get_result**
- Obtener el resultado final de un sub-agente completado

### Comunicación entre agentes
- No hay memoria compartida directa (no es un monolito)
- Los resultados se pasan via el agente padre como mensajes en su contexto
- Patrón mailbox: el agente padre actúa como coordinador; agentes peligrosos envían sus acciones al padre para aprobación antes de ejecutar

### Aislamiento de sub-agentes
- Sub-agentes operan en su propio directorio o git worktree
- No pueden modificar el estado del padre
- Permiso más restrictivo que el padre por defecto (opt-in para expandir)
- En sub-agentes de batch/CI: auto-deny para comandos peligrosos por defecto

### Coordinador (Coordinator pattern)
Para tareas complejas con múltiples sub-agentes paralelos:
- El agente principal actúa como coordinador
- Spawn de N agentes worker en paralelo
- Los workers reportan resultados al coordinador
- El coordinador integra, valida y decide los pasos siguientes
- Las acciones peligrosas de workers requieren aprobación del coordinador (no directa del usuario)

### Git worktrees para paralelización
Cada sub-agente puede operar en su propio git worktree para que sus cambios no interfieran con los demás hasta el merge explícito.

---

## 14. Sesiones y persistencia

### Modelo de sesión
Una sesión es una unidad de trabajo completa. Tiene:
- ID único (UUID)
- Timestamp de inicio y fin
- Directorio de trabajo
- Modelo usado
- Historial completo de mensajes (JSONL)
- Archivos modificados (con checkpoints para rewind)
- Metadatos (tokens usados, costo estimado, número de tool calls)

### Operaciones sobre sesiones

**Resume**
- Reabrir una sesión anterior con el mismo historial
- La conversación continúa desde donde se dejó
- Los permisos NO se restauran; se re-establecen por sesión por razones de seguridad
- Selección via picker o `aficax resume --last`

**Fork**
- Crear una nueva sesión desde un punto específico del historial de otra
- Útil para explorar caminos alternativos sin perder el original

**Rewind**
- Revertir archivos al estado que tenían antes de una operación específica
- Requiere que los checkpoints estén activados
- Solo afecta archivos, no el historial de conversación

**Archive**
- Marcar una sesión como archivada
- Se excluye de la lista principal pero su historial permanece accesible

### Persistencia técnica
- SQLite (via Drizzle ORM o equivalente) para sesiones, mensajes, metadatos
- JSONL append-only para transcripts completos (inmutables, solo se agregan marcadores)
- JSON para snapshots rápidos de configuración
- Checkpoints de archivos en `~/.aficax/file-history/<sessionId>/`

### Chain patching
Cuando se compacta un historial, se registran: headUuid, anchorUuid, tailUuid. El cargador de sesiones parchea la cadena de mensajes en tiempo de lectura. Nada se edita destructivamente en disco.

---

## 15. Configuración multicapa

### Jerarquía (de menor a mayor precedencia)
1. Valores por defecto del código
2. Configuración global del usuario: `~/.aficax/config.json`
3. Configuración del proyecto: `.aficax/settings.json` (en raíz del repo)
4. Configuración del directorio: `.aficax/settings.json` (en subdirectorio)
5. Variables de entorno: `AFICAX_*`
6. Flags de línea de comandos: `--model`, `--no-sandbox`, etc.

### Scopes de settings

**Global (~/.aficax/config.json)**
- Provider y modelo por defecto
- API keys (referenciadas como variables de entorno, no hardcodeadas)
- Preferencias de UI (tema, shortcuts)
- Modo de aprobación por defecto
- Memoria y MEMORY.md global
- MCP servers globales
- Allowlist/denylist global

**Proyecto (.aficax/settings.json)**
- Override de provider/modelo para el proyecto
- Herramientas deshabilitadas (`disallowedTools`)
- Herramientas requeridas (`requiredTools`)
- MCP servers específicos del proyecto
- Hooks del proyecto
- Modo de aprobación del proyecto
- Skills del proyecto

**Por agente (en definición YAML de agente custom)**
- Tools permitidas
- Modelo específico
- Max turns
- Permission mode
- MCP servers
- Hooks
- Memory scope
- Modo background

### Variables de entorno reconocidas
- `AFICAX_API_KEY` / `AFICAX_ANTHROPIC_KEY` / `AFICAX_OPENAI_KEY` / etc.
- `AFICAX_MODEL`: modelo por defecto
- `AFICAX_NO_SANDBOX`: deshabilitar sandbox (peligroso)
- `AFICAX_CI`: activar modo CI/headless
- `AFICAX_LOG_LEVEL`: nivel de logging
- `AFICAX_MAX_TOKENS`: límite de tokens por sesión
- `AFICAX_LOCAL_ENDPOINT`: URL del backend local

### Custom agents (YAML)
Definición de agentes especializados para tareas recurrentes:
```yaml
name: security-reviewer
description: Revisa código en busca de vulnerabilidades
model: anthropic/claude-opus-4
tools: [read_file, grep, glob, web_search]
disallowedTools: [bash, write_file]
permissionMode: read-only
systemPrompt: Eres un experto en seguridad...
maxTurns: 20
mcpServers: [vuln-db]
skills: [owasp-checklist]
```

---

## 16. Skills (habilidades reutilizables)

### Qué es un skill
Un archivo Markdown estructurado que provee instrucciones específicas, contexto y procedimientos para tareas recurrentes. El agente lo carga cuando la tarea es relevante para ese skill.

### Estructura de un skill
```markdown
---
name: nombre-del-skill
description: cuándo usar este skill (el agente usa esto para seleccionarlo)
tools: [herramientas requeridas]
triggers: [patrones de tarea que activan este skill automáticamente]
---

# Instrucciones
...procedimiento paso a paso...

# Ejemplos
...ejemplos de input y output esperado...

# Restricciones
...qué NO hacer...
```

### Localización de skills
- Built-in: skills que vienen con Aficax (linting, testing, commit messages, code review, etc.)
- Proyecto: `.aficax/skills/` en el repositorio
- Global: `~/.aficax/skills/`
- Instalados: skills de terceros con sistema de instalación controlado

### Activación de skills
- **Manual**: el usuario lo menciona explícitamente o usa `@skill-name`
- **Automática**: el agente detecta que la tarea coincide con el trigger del skill
- **Siempre activo**: skills marcados como `always: true` se inyectan en cada sesión del proyecto

### Skills de ejemplo incluidos en Aficax
- `git-commit`: convenciones de commit messages, formato, scope
- `code-review`: checklist de revisión de código
- `test-generation`: estrategia para generar tests por tipo de código
- `refactoring`: procedimiento para refactors seguros
- `debugging`: estrategia de debugging sistemático
- `documentation`: generación de documentación técnica

---

## 17. Interfaz CLI y TUI

### Modos de interfaz

**TUI interactiva (modo principal)**
- Interfaz de terminal completa con panels
- Input multilinea
- Streaming de respuesta token a token
- Diff viewer integrado (side-by-side o unified)
- Lista de tool calls en ejecución
- Indicadores de estado (modelo activo, tokens usados, modo)
- Atajos de teclado para operaciones frecuentes

**CLI no-interactiva (modo pipe/CI)**
- `aficax exec "tarea"`: ejecutar tarea y salir
- `aficax exec --no-interactive "tarea"`: sin prompts de aprobación (requiere configuración previa)
- Input desde stdin, output a stdout
- Exit codes según éxito/fallo

**SDK (para integración en otros sistemas)**
- Aficax como librería importable
- API programática para crear sesiones, enviar mensajes, recibir resultados

### Layout de la TUI

**Panel principal (80%+ de altura)**
- Historial de conversación con el modelo
- Tool calls expandibles (click o atajo para ver/ocultar)
- Diffs de archivos coloreados inline
- Indicadores de aprobación pendiente

**Panel de estado (barra inferior)**
- Modelo activo + provider
- Tokens usados / total disponible (barra de progreso)
- Modo actual (plan, auto, full, read-only)
- MCP servers activos
- Indicador de sesión (nombre o ID)

**Panel de input**
- Input multilinea con sintaxis resaltada básica
- Sugerencias de slash commands al escribir /
- @ para file search fuzzy (buscar archivos del workspace para incluir en el mensaje)
- Historial de comandos navegable con flechas

### Rendering técnico
- Implementado con una librería de TUI (Ink/React para terminal, Charm's Bubbletea, Ratatui en Rust, o equivalente según el lenguaje elegido)
- El mismo componente de herramienta (Tool) funciona independientemente del renderer
- Soporte para terminales con colores de 256 colores y true color
- Degradación graceful para terminales básicas

---

## 18. Menú y comandos slash

### Comandos slash principales

**Gestión de sesión**
- `/new`: iniciar nueva sesión
- `/resume [session_id]`: retomar sesión anterior
- `/fork`: crear fork de la sesión actual desde este punto
- `/rewind`: revertir archivos al estado anterior a la operación seleccionada
- `/compact`: forzar compactación manual del contexto ahora
- `/status`: mostrar estado de sesión (tokens, modo, modelo, MCP servers, costo estimado)
- `/clear`: limpiar pantalla sin borrar historial

**Control del modelo**
- `/model [nombre]`: cambiar modelo mid-sesión
- `/provider [nombre]`: cambiar provider
- `/effort [low|medium|high]`: ajustar reasoning effort (si el modelo lo soporta)

**Control de modo**
- `/plan`: activar modo solo planificación
- `/read-only`: activar modo solo lectura
- `/auto`: activar modo auto
- `/full`: activar modo acceso completo
- `/sandbox`: activar sandbox mode

**Herramientas y context**
- `/tools`: listar herramientas disponibles y su estado
- `/mcp`: listar MCP servers conectados y sus herramientas
- `/skills`: listar skills disponibles y activos
- `/memory`: ver y editar la memoria del agente para este proyecto
- `/context`: mostrar qué hay en el context window actual (resumen)

**Git**
- `/diff`: mostrar diff de todos los cambios de la sesión
- `/commit [mensaje]`: hacer commit de los cambios actuales
- `/undo`: revertir último commit (git revert)

**Revisión y verificación**
- `/review`: solicitar al agente que revise los cambios antes de commit
- `/test`: ejecutar la suite de tests del proyecto
- `/lint`: ejecutar linters configurados

**Configuración rápida**
- `/config [clave] [valor]`: cambiar configuración sin editar archivos
- `/allow [comando]`: agregar comando a la allowlist permanente
- `/deny [comando]`: agregar comando a la denylist permanente

**Utilidades**
- `/help [comando]`: ayuda sobre comando específico o lista de todos
- `/cost`: mostrar estimado de costo de la sesión actual
- `/history`: ver historial de sesiones anteriores
- `/debug`: toggle de modo debug (muestra prompts internos, tool calls completos)

### Atajos de teclado (TUI)

- `Ctrl+C`: interrumpir la operación actual (el agente guarda checkpoint y espera)
- `Ctrl+D` / `Escape`: salir de Aficax (con confirmación si hay cambios sin guardar)
- `Tab`: completar slash command o nombre de archivo en @-references
- `Enter`: enviar mensaje (en input de línea única)
- `Shift+Enter`: nueva línea en input (modo multilinea)
- `Ctrl+L`: limpiar pantalla
- `Ctrl+Z`: deshacer última acción del agente (si está disponible)
- `↑/↓`: navegar historial de input
- `Ctrl+K`: activar modo plan

### Input en ejecución
El usuario puede enviar input mientras el agente está ejecutando herramientas:
- `Enter`: inyectar instrucción en el turno actual (el agente la ve antes de su próxima decisión)
- `Tab`: encolar input para el próximo turno
- `Ctrl+C`: interrumpir y pedir confirmación

---

## 19. Indexación de repositorio

### Propósito
El repo-map permite al agente entender la estructura del codebase sin meter todos los archivos en el contexto.

### Componentes del índice

**Árbol de símbolos (repo map)**
- Construido con tree-sitter para parsear código fuente
- Genera un grafo de símbolos: funciones, clases, interfaces, exports
- Ranking de importancia por frecuencia de uso y centralidad en el grafo de dependencias
- El agente puede consultar el repo map para entender qué archivos son relevantes antes de leerlos

**Índice de texto (búsqueda)**
- ripgrep integrado para búsqueda de texto full-text
- Soporte para expresiones regulares
- Filtros por extensión, directorio, patrón de nombre

**Búsqueda semántica (opcional)**
- Embeddings de archivos/chunks almacenados localmente
- Permite buscar por similitud semántica (útil para "encuentra código similar a esto")
- Requiere modelo de embeddings local o API de embeddings

### Actualización del índice
- Incremental: solo re-indexar archivos modificados desde el último índice
- Disparado por: inicio de sesión, cambios detectados por file watcher, solicitud manual
- El índice se invalida si cambian archivos de configuración del proyecto (.gitignore, etc.)

### Qué se excluye del índice
- Todo lo que está en `.gitignore`
- Archivos binarios
- Archivos muy grandes (configurable, ej. >1MB)
- Directorios de dependencias (`node_modules`, `__pycache__`, `.venv`, etc.)

---

## 20. Sistema de diff y edición de archivos

### Formatos de edición soportados

**Search/replace (el más confiable)**
- El modelo provee: bloque exacto a reemplazar + bloque nuevo
- Aficax busca el bloque en el archivo y lo reemplaza
- Falla explícitamente si el bloque no se encuentra (evita ediciones silenciosas incorrectas)

**Diff/patch unificado**
- El modelo provee un diff en formato unificado
- Aficax aplica el patch con validación
- Mejor para cambios grandes o múltiples huecos en el mismo archivo

**Whole-file**
- El modelo provee el archivo completo
- Aficax sobreescribe
- Más simple pero consume más tokens; para archivos pequeños o cuando el modelo no soporta diff

**MultiEdit atómico**
- Múltiples operaciones search/replace en múltiples archivos
- Todo se aplica como una transacción: si una operación falla, ninguna se aplica
- Crítico para refactors que tocan múltiples archivos de forma coordinada

### Verificación de ediciones
Después de aplicar cualquier edición:
- Verificar que el archivo resultante es parseable (tree-sitter u otro parser según el lenguaje)
- Opcional: ejecutar linter del lenguaje para detectar errores de sintaxis
- Si hay error de parseo: notificar al modelo y ofrecer reintento

### Diff viewer en TUI
- Visualización side-by-side o unificada
- Colores: verde para adiciones, rojo para eliminaciones, gris para contexto
- Navegación entre hunks con atajos de teclado
- Capacidad de aprobar/rechazar hunks individuales (edición interactiva del diff)

### Checkpoints de archivos
Antes de cualquier escritura en un archivo, guardar una copia en `~/.aficax/file-history/<sessionId>/<timestamp>_<filepath>`. Esto permite el rewind granular.

---

## 21. Telemetría y observabilidad

### Qué registrar

**Por sesión**
- ID de sesión, timestamp, directorio, modelo usado
- Número de turnos, total de tool calls
- Tokens de input y output (totales y por turno)
- Costo estimado (si se conocen los precios del provider)
- Duración total
- Resultado: completado, interrumpido, error

**Por tool call**
- Herramienta usada
- Input (con redacción de secretos/credenciales)
- Output (truncado si es muy largo)
- Duración de ejecución
- Si fue aprobada, rechazada, o bloqueada por política
- Resultado: éxito, error, timeout

**Por API call**
- Modelo, tokens input/output, duración, error si aplica
- Resultado de compactación si se disparó

**Por hook**
- Hook ejecutado, evento, duración, resultado

### Transcripts
- JSONL append-only: cada mensaje, tool call y resultado se agrega como una línea JSON
- Nunca se edita; las compactaciones agregan líneas de marcador con el resumen
- Permiten reconstruir exactamente qué hizo el agente en cada sesión

### Logging estructurado
- Niveles: DEBUG, INFO, WARN, ERROR
- Formato JSON para parseo automático
- Rotación de logs configurables
- La salida de debug puede mostrarse en la TUI con `/debug`

### Métricas de uso
- Opcional y opt-in: reporte anónimo de métricas de uso a servidor propio o de terceros
- Nunca incluye código fuente ni prompts del usuario
- Para detectar patrones de error y optimizar el agente

### Privacidad
- Toda telemetría es local por defecto
- Las keys, tokens y secretos nunca aparecen en logs (pipeline de redacción automática)
- El usuario controla qué se logea y qué se reporta externamente

---

## 22. Optimización y rendimiento

### Velocidad de respuesta

**Streaming**
- Las respuestas del modelo se muestran token a token, no al final
- El diff viewer puede construirse incrementalmente mientras llegan tokens
- Las tool calls pueden iniciarse tan pronto como se detectan en el stream, sin esperar el fin del mensaje

**Prompt caching**
- La zona estática del system prompt (instrucciones base, AFICAX.md global) se marca para caché
- Reduce latencia y costo en llamadas repetidas al mismo proyecto
- El provider Anthropic lo soporta nativamente; otros providers tienen equivalentes

**Ripgrep para búsqueda**
- Búsqueda de texto usando ripgrep (binario nativo embedido), no implementación JavaScript/Python
- Órdenes de magnitud más rápido que herramientas de búsqueda del sistema en repos grandes

**Tree-sitter para indexación**
- Parser nativo compilado, significativamente más rápido que parsers en Python/JavaScript para repos grandes

**Lazy loading de contexto**
- No cargar todos los archivos al inicio
- El agente solicita archivos cuando los necesita
- La caché de archivos recientes evita re-lecturas innecesarias

### Optimización de tokens

**Token budget tracking**
- Calcular tokens exactos en cada turno antes de la API call (con el tokenizer del modelo si está disponible, o una aproximación calibrada)
- Evitar sorpresas de context overflow

**Tool output truncation**
- Los outputs muy largos de herramientas se truncan antes de entrar al contexto
- Se provee al modelo un indicador de que hubo truncación y cómo obtener el contenido completo

**Selective file injection**
- Post-compactación, solo re-inyectar archivos que el agente ha leído recientemente y que son probablemente necesarios para continuar

**Symbol-level context**
- En lugar de inyectar archivos completos, inyectar solo las firmas de funciones/clases relevantes del repo map, y leer el cuerpo completo solo cuando sea necesario

### Paralelización
- Sub-agentes ejecutan en paralelo (threads o procesos separados)
- Múltiples tool calls en un mismo turno pueden ejecutarse en paralelo si no tienen dependencias entre sí
- Indicar en el schema de cada tool si soporta ejecución paralela

### Cold start
- Mantener un índice de repo pre-construido para arranque rápido
- Cachear el system prompt base compilado para no reconstruirlo en cada turno

---

## 23. Personalización

### Configuración de comportamiento
- **Idioma de respuesta**: el agente responde en el idioma que usa el usuario por defecto; configurable explícitamente
- **Verbosidad**: mínima (solo resultados), normal (con explicaciones), detallada (con razonamiento)
- **Auto-commit**: si el agente hace commit automáticamente después de editar o espera instrucción
- **Auto-test**: si el agente ejecuta tests automáticamente después de cada edición
- **Format de mensajes**: estilo de los mensajes del agente (conciso, extenso, con emojis, sin)

### Personalización del agente

**Nombre y personalidad**
El nombre "Aficax" y el tono se configuran en el system prompt base. Completamente reemplazable.

**System prompt personalizado**
El usuario puede agregar instrucciones globales en AFICAX.md o en settings que se inyectan en el system prompt base de cada sesión.

**Restricciones globales**
Configurar en settings qué herramientas están siempre deshabilitadas, qué rutas nunca puede tocar, qué comandos nunca puede ejecutar.

**Preferencias de código**
En AFICAX.md del proyecto:
- Lenguaje de programación preferido
- Framework y librería standards
- Convenciones de naming
- Estilo de tests (TDD, BDD, etc.)
- Convenciones de commit messages

### Temas de TUI
- Paleta de colores configurable (dark, light, custom)
- Modo de diff (side-by-side, unificado)
- Densidad de información (compact, comfortable)
- Fuente (si el terminal la soporta)

### Keybindings
Todos los atajos de teclado son configurables en settings. Sin keybindings hardcoded (excepto los más básicos como Ctrl+C para interrumpir).

---

## 24. Seguridad general

### Principios
- Least privilege: el agente solo tiene acceso a lo que necesita para la tarea actual
- Defense in depth: múltiples capas (permisos → hooks → sandbox → OS) que no dependen de que una sola funcione
- Auditabilidad: todo lo que el agente hace queda registrado y es reversible
- Fail-closed: cuando hay duda, no ejecutar

### Gestión de secretos
- Las API keys se leen desde variables de entorno, nunca desde archivos de configuración plaintext
- El agente nunca lee archivos de credenciales (.env, .aws/credentials, .ssh/) a menos que el usuario lo apruebe explícitamente y lo mencione
- Los outputs de comandos que contengan patrones de secretos (tokens de 20+ caracteres, formatos de API key conocidos) se redactan automáticamente en los logs y en lo que ve el modelo

### Prompt injection
- El contenido de archivos leídos del repositorio es potencialmente malicioso (puede contener instrucciones para el modelo)
- Tratar todo el contenido externo como no confiable
- Las instrucciones en archivos del repo no deben tener el mismo nivel de autoridad que el system prompt del usuario
- Las instrucciones en MCP servers remotos se sandboxean en cuanto a qué pueden autorizar

### Supply chain de MCP
- Antes de conectar un MCP server, mostrar al usuario qué herramientas expone
- Nunca auto-instalar MCP servers sin confirmación
- Las actualizaciones de MCP servers instalados se revisan como una dependencia de software

### Clonado de repositorios
- Al clonar un repo, las settings de `.aficax/` del repo clonado no se activan automáticamente
- Requieren confirmación del usuario antes de cargar configuración de repos externos (posible prompt injection via settings)

### Rotación de credenciales
- Si se sospecha que el agente accedió a credenciales, instrucciones claras en la documentación para rotarlas
- El transcript de la sesión permite determinar exactamente qué comandos se ejecutaron

---

## 25. Estructura de archivos del proyecto

### Directorio del usuario (~/.aficax/)
```
~/.aficax/
├── config.json              # Configuración global del usuario
├── AFICAX.md                # Memoria e instrucciones globales
├── MEMORY.md                # Preferencias personales persistentes
├── skills/                  # Skills globales del usuario
│   └── *.md
├── hooks.json               # Hooks globales
├── mcp.json                 # MCP servers globales
├── sessions/                # Historial de sesiones
│   └── <session-id>/
│       ├── transcript.jsonl
│       └── metadata.json
├── file-history/            # Checkpoints de archivos para rewind
│   └── <session-id>/
│       └── <timestamp>_<filepath>
└── logs/                    # Logs rotados
```

### Directorio del proyecto (.aficax/)
```
.aficax/
├── settings.json            # Configuración del proyecto
├── AFICAX.md                # Instrucciones y memoria del proyecto (mismo que el raíz)
├── hooks.json               # Hooks del proyecto
├── mcp.json                 # MCP servers del proyecto
├── skills/                  # Skills del proyecto
│   └── *.md
└── agents/                  # Definiciones de agentes custom en YAML
    └── *.yaml
```

### Archivos en raíz del proyecto (visibles en git)
```
AFICAX.md                    # Instrucciones del proyecto para el agente (commiteable)
```

### Estructura interna del binario de Aficax
```
aficax/
├── src/
│   ├── cli/                 # Entry points, CLI parsing
│   ├── ui/                  # TUI components y renderer
│   ├── engine/              # QueryEngine, loop principal
│   ├── tools/               # Implementaciones de herramientas
│   ├── providers/           # Adaptadores de providers de IA
│   ├── mcp/                 # Cliente y servidor MCP
│   ├── context/             # Gestión de contexto y compactación
│   ├── memory/              # Sistema de memoria y sesiones
│   ├── permissions/         # Motor de permisos
│   ├── sandbox/             # Sandboxing por plataforma
│   ├── hooks/               # Sistema de hooks
│   ├── indexer/             # Indexación de repositorio (tree-sitter, ripgrep)
│   ├── config/              # Carga y merge de configuración
│   ├── storage/             # SQLite, JSONL, filesystem
│   └── telemetry/           # Logging y métricas
└── skills/                  # Skills built-in empaquetados
```

---

## Notas de implementación

### Lenguaje de implementación recomendado
- **Rust**: máximo rendimiento, memory safety, binario único, excelente para CLIs. Codex CLI lo usa.
- **TypeScript + Bun**: desarrollo más rápido, ecosistema npm, bundle en un solo archivo. Claude Code y OpenCode lo usan.
- **Python**: prototipado rápido, ecosistema AI más amplio. Aider lo usa.

La elección afecta principalmente la velocidad de arranque, el tamaño del binario, y la facilidad de integración con librerías existentes.

### Orden de implementación sugerido

1. Loop básico con un provider (Anthropic o Ollama)
2. Herramientas básicas: read_file, bash, write_file
3. TUI mínima con streaming
4. Permisos y aprobación manual
5. Sesiones y persistencia básica
6. Compactación de contexto
7. MCP client
8. Hooks
9. Sub-agentes
10. Indexación de repo
11. Skills
12. Sandbox
13. Multi-provider
14. Telemetría completa

### Lo que la mayoría omite y no debería
- Circuit breakers en compactación (evita loops infinitos de compactación fallida)
- Tombstones en historial al cambiar modelos (evita inconsistencias)
- Checkpoints de archivos para rewind (no solo deshacer en git)
- Redacción automática de secretos en logs
- Validación de contenido de repos clonados antes de cargar su .aficax/
