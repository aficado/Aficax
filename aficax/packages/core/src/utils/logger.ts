// C:\Users\aficado\Desktop\Aficax\aficax\packages\core\src\utils\logger.ts
// Structured JSON logger that writes to stderr, with automatic redaction of
// known credential patterns (API keys, OAuth tokens, AWS access keys, ...).

/** Supported severity levels, ordered from least to most severe. */
export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

const LEVEL_ORDER: Record<LogLevel, number> = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
};

/** A free-form context bag attached to every log entry. */
export type LogContext = Record<string, unknown>;

/**
 * Regular expressions matching well-known secret formats. Each pattern is
 * applied globally and the match is replaced with `[REDACTED]`. Patterns are
 * intentionally specific to minimise false positives in code or filenames.
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  // Anthropic API keys
  /sk-ant-[a-zA-Z0-9_-]{20,}/g,
  // OpenAI API keys
  /sk-[a-zA-Z0-9]{20,}/g,
  // GitHub tokens (classic and fine-grained)
  /gh[pousr]_[a-zA-Z0-9]{20,}/g,
  // AWS access key IDs
  /AKIA[A-Z0-9]{16}/g,
  // Bearer tokens in Authorization-like contexts
  /Bearer\s+[a-zA-Z0-9-_.=]+/gi,
  // Slack tokens
  /xox[baprs]-[a-zA-Z0-9-]+/g,
  // Google API keys
  /AIza[0-9A-Za-z_-]{35}/g,
];

/**
 * Replace every secret-looking substring in `text` with the literal
 * `[REDACTED]`. The original object is not mutated.
 */
export function redactSecrets(text: string): string {
  let result = text;
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, '[REDACTED]');
  }
  return result;
}

/** Recursively redact every string value in an arbitrary context object. */
export function redactContext(value: unknown): unknown {
  if (typeof value === 'string') {
    return redactSecrets(value);
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactContext(entry));
  }
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source)) {
    out[key] = redactContext(source[key]);
  }
  return out;
}

/** Severity-aware structured logger. */
export class Logger {
  private minLevel: LogLevel;
  private readonly stream: { write(line: string): void };

  constructor(
    minLevel: LogLevel = 'INFO',
    stream: { write(line: string): void } = {
      write: (line: string): void => {
        process.stderr.write(line);
      },
    },
  ) {
    this.minLevel = minLevel;
    this.stream = stream;
  }

  /** Log a debug-level message. */
  debug(message: string, context: LogContext = {}): void {
    this.log('DEBUG', message, context);
  }

  /** Log an info-level message. */
  info(message: string, context: LogContext = {}): void {
    this.log('INFO', message, context);
  }

  /** Log a warning-level message. */
  warn(message: string, context: LogContext = {}): void {
    this.log('WARN', message, context);
  }

  /** Log an error-level message. */
  error(message: string, context: LogContext = {}): void {
    this.log('ERROR', message, context);
  }

  /** Update the minimum severity threshold. */
  setLevel(level: LogLevel): void {
    this.minLevel = level;
  }

  private log(level: LogLevel, message: string, context: LogContext): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.minLevel]) {
      return;
    }
    const safeMessage = redactSecrets(message);
    const safeContext = redactContext(context) as LogContext;
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      message: safeMessage,
      ...safeContext,
    };
    this.stream.write(JSON.stringify(entry) + '\n');
  }
}

let defaultLogger: Logger | null = null;

/** Return the process-wide default logger, creating it on first use. */
export function getLogger(): Logger {
  if (defaultLogger === null) {
    const level = parseLogLevel(process.env['AFICAX_LOG_LEVEL']) ?? 'INFO';
    defaultLogger = new Logger(level);
  }
  return defaultLogger;
}

/** Set the minimum severity of the process-wide default logger. */
export function setLogLevel(level: LogLevel): void {
  getLogger().setLevel(level);
}

/** Replace the process-wide default logger (used by tests). */
export function setDefaultLogger(logger: Logger): void {
  defaultLogger = logger;
}

/** Parse a `LogLevel` from a free-form string. Returns undefined on failure. */
export function parseLogLevel(value: string | undefined): LogLevel | undefined {
  if (value === undefined) {
    return undefined;
  }
  const upper = value.toUpperCase();
  if (upper === 'DEBUG' || upper === 'INFO' || upper === 'WARN' || upper === 'ERROR') {
    return upper;
  }
  return undefined;
}
