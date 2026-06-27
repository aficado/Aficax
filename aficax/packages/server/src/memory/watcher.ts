// C:\Users\aficado\Desktop\Aficax\aficax\packages\server\src\memory\watcher.ts
// FileWatcher: notify subscribers when an AFICAX.md (or MEMORY.md) changes.
//
// The watcher uses Bun's native fs.watch API for low overhead. Callers
// subscribe via {@link FileWatcher.subscribe}; the subscriber is invoked
// once per batched change with the list of affected paths. A pending
// rebuild flag is also maintained so the QueryEngine can decide whether
// to rebuild the system prompt on the next turn.
//
// Debouncing
// ----------
// File-system events on macOS / Linux / Windows are noisy: a single
// "save file" can produce several events. We coalesce every event that
// arrives within {@link DEBOUNCE_MS} into a single notification, so
// subscribers see one "change" per logical save.

import { stat, watch as fsWatch } from 'node:fs';
import { promisify } from 'node:util';

import { getLogger } from '@aficax/core';

const logger = getLogger();

/** Coalesce window in ms. */
const DEBOUNCE_MS = 150;

const statAsync = promisify(stat);

/** One notification batch delivered to subscribers. */
export interface WatcherChange {
  /** Absolute path of the file that changed. */
  readonly path: string;
  /** Coarse kind of change observed. */
  readonly kind: WatcherEventKind;
  /** Timestamp (ms) of the notification. */
  readonly timestamp: number;
  /** Size in bytes after the change (0 when missing). */
  readonly sizeBytes: number;
}

export type WatcherEventKind = 'change' | 'rename' | 'create' | 'delete';

/** A subscriber that receives change notifications. */
export type WatcherSubscriber = (changes: readonly WatcherChange[]) => void;

/** Public configuration of {@link FileWatcher}. */
export interface FileWatcherOptions {
  /** Paths to watch. Glob patterns are NOT supported. */
  readonly paths: readonly string[];
  /** Optional callback invoked once per batched change set. */
  readonly onChange?: WatcherSubscriber;
  /** Override the fs.watch implementation (tests). */
  readonly watchImpl?: WatchImpl;
  /** Override the debounce window (ms). Defaults to {@link DEBOUNCE_MS}. */
  readonly debounceMs?: number;
  /** Override the clock (tests). */
  readonly now?: () => number;
}

/**
 * Minimal subset of `fs.watch` that the watcher depends on. Exposed for
 * tests so the watcher can be driven by an in-memory event stream.
 */
export interface WatchImpl {
  watch(
    filename: string,
    options: { readonly persistent?: boolean },
    listener: (event: 'change' | 'rename', filename: string | Buffer | null) => void,
  ): { close(): void };
}

const defaultWatchImpl: WatchImpl = {
  watch(filename, options, listener) {
    const handle = fsWatch(filename, { persistent: options.persistent ?? false }, (event, name) => {
      listener(event, name);
    });
    return { close: () => handle.close() };
  },
};

/**
 * Watch a list of AFICAX.md / MEMORY.md files. One instance can watch many
 * files; subscribers receive batched notifications. The instance also
 * exposes a `pendingRebuild` flag that the QueryEngine checks at the start
 * of each turn to decide whether to rebuild the system prompt.
 */
export class FileWatcher {
  private readonly paths: readonly string[];
  private readonly subscribers: Set<WatcherSubscriber> = new Set();
  private readonly watchImpl: WatchImpl;
  private readonly debounceMs: number;
  private readonly now: () => number;
  private readonly handles: Map<string, { close(): void }> = new Map();
  private readonly pendingTimers: Map<string, NodeJS.Timeout> = new Map();
  private pendingRebuild = false;
  private lastSeenMtime: Map<string, number> = new Map();
  private running = false;

  constructor(options: FileWatcherOptions) {
    this.paths = [...options.paths];
    this.watchImpl = options.watchImpl ?? defaultWatchImpl;
    this.debounceMs = options.debounceMs ?? DEBOUNCE_MS;
    this.now = options.now ?? Date.now;
    if (options.onChange !== undefined) {
      this.subscribers.add(options.onChange);
    }
  }

  /** `true` when at least one watched file changed since the last consume. */
  get pending(): boolean {
    return this.pendingRebuild;
  }

  /** True after {@link start} has been called. */
  get isRunning(): boolean {
    return this.running;
  }

  /** Subscribe to change notifications. Returns an unsubscribe function. */
  subscribe(subscriber: WatcherSubscriber): () => void {
    this.subscribers.add(subscriber);
    return () => {
      this.subscribers.delete(subscriber);
    };
  }

  /** Acknowledge the pending rebuild (called by the QueryEngine). */
  consumePendingRebuild(): boolean {
    const was = this.pendingRebuild;
    this.pendingRebuild = false;
    return was;
  }

  /**
   * Begin watching every configured path. Safe to call multiple times;
   * subsequent calls are no-ops until {@link stop} is invoked.
   */
  start(): void {
    if (this.running) return;
    this.running = true;
    for (const path of this.paths) {
      this.watchOne(path).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn('watcher: failed to arm', { path, error: message });
      });
    }
  }

  /** Stop every watcher and cancel any pending timers. */
  stop(): void {
    this.running = false;
    for (const handle of this.handles.values()) {
      try {
        handle.close();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.debug('watcher: handle.close raised', { error: message });
      }
    }
    this.handles.clear();
    for (const timer of this.pendingTimers.values()) {
      clearTimeout(timer);
    }
    this.pendingTimers.clear();
  }

  // -- Internals ---------------------------------------------------------

  private async watchOne(path: string): Promise<void> {
    // Cache the initial mtime so we can detect a real change vs. the
    // spurious "change" event some platforms fire when the watcher arms.
    try {
      const info = await statAsync(path);
      this.lastSeenMtime.set(path, info.mtimeMs);
    } catch {
      this.lastSeenMtime.set(path, 0);
    }
    const handle = this.watchImpl.watch(
      path,
      { persistent: false },
      (event, _filename) => {
        this.handleEvent(path, event);
      },
    );
    this.handles.set(path, handle);
    logger.debug('watcher: armed', { path });
  }

  private handleEvent(path: string, event: 'change' | 'rename'): void {
    // Coalesce: clear any existing timer and arm a new one.
    const existing = this.pendingTimers.get(path);
    if (existing !== undefined) {
      clearTimeout(existing);
    }
    const timer = setTimeout(() => {
      this.pendingTimers.delete(path);
      void this.flushEvent(path, event);
    }, this.debounceMs);
    this.pendingTimers.set(path, timer);
  }

  private async flushEvent(path: string, event: 'change' | 'rename'): Promise<void> {
    if (!this.running) return;
    let sizeBytes = 0;
    let kind: WatcherEventKind = event;
    try {
      const info = await statAsync(path);
      sizeBytes = info.size;
      const prev = this.lastSeenMtime.get(path) ?? 0;
      if (info.mtimeMs !== prev) {
        kind = 'change';
        this.lastSeenMtime.set(path, info.mtimeMs);
      }
    } catch {
      kind = 'delete';
      this.lastSeenMtime.set(path, 0);
    }
    this.pendingRebuild = true;
    const change: WatcherChange = {
      path,
      kind,
      timestamp: this.now(),
      sizeBytes,
    };
    for (const sub of this.subscribers) {
      try {
        sub([change]);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn('watcher: subscriber threw', { error: message });
      }
    }
  }
}

/** Factory that creates a fresh {@link FileWatcher}. */
export function createFileWatcher(options: FileWatcherOptions): FileWatcher {
  return new FileWatcher(options);
}