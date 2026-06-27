// C:\Users\aficado\Desktop\Aficax\aficax\packages\server\src\hooks\index.ts
// Barrel re-export for the hooks subsystem.

export {
  DEFAULT_HOOK_TIMEOUT_MS,
  HOOK_EVENTS,
  isHookEvent,
  normaliseHookDefinition,
  type BaseContext,
  type HookContext,
  type HookDefinition,
  type HookError,
  type HookEvent,
  type HookReply,
  type HookResult,
  type HooksFile,
  type OnErrorContext,
  type OnSessionEndContext,
  type OnSessionStartContext,
  type PostAPICallContext,
  type PostToolUseContext,
  type PreAPICallContext,
  type PreToolUseContext,
  type PreUserPromptSubmitContext,
  type ResolvedHook,
} from './schema.js';

export {
  HookRegistry,
  createHookRegistry,
  type HookRegistryOptions,
} from './registry.js';

export {
  HookDispatcher,
  createHookDispatcher,
  defaultSpawn,
  tokenise,
  type DispatcherChild,
  type HookProvider,
  type ShellTokeniser,
  type SpawnFn,
  type HookDispatcherOptions,
} from './dispatcher.js';
