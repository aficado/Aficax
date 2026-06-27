// C:\Users\aficado\Desktop\Aficax\aficax\packages\server\src\indexer\file-cache.ts
// FileCache: a small LRU cache of recently-read files.
//
// The cache is the indexer's hot path: the repo-map builder reads every
// supported source file once per `build()`, and tool calls (`read_file`,
// `grep`) re-read files the agent has touched recently. Keeping the last
// 50 files (or 10 MB) in memory turns those reads into zero-cost hits.
//
// Eviction policy is plain LRU: the cached entry whose `lastUsedAt` is
// the smallest is dropped first, both when the entry count crosses the
// limit and when the cumulative byte size crosses the size limit.

/** Maximum number of entries before the cache starts evicting. */
export const DEFAULT_FILE_CACHE_MAX_ENTRIES = 50;
/** Maximum cumulative bytes before the cache starts evicting. */
export const DEFAULT_FILE_CACHE_MAX_BYTES = 10 * 1024 * 1024;

/** A cached file payload. */
export interface CachedFile {
  /** Absolute path of the file. */
  readonly path: string;
  /** UTF-8 content. May be empty for zero-byte files. */
  readonly content: string;
  /** Size in bytes (cached so eviction math does not re-count). */
  readonly bytes: number;
  /** Last `get`/`set` time in ms (monotonic via the injected clock). */
  readonly lastUsedAt: number;
  /** Original `mtimeMs` of the file when it was loaded. */
  readonly mtimeMs: number;
}

/** Public configuration of {@link FileCache}. */
export interface FileCacheOptions {
  readonly maxEntries?: number;
  readonly maxBytes?: number;
  /** Override the clock (tests). */
  readonly now?: () => number;
}

interface Entry extends CachedFile {}

/**
 * LRU file cache. Construction is O(1); every public method is O(1)
 * amortised, except `getRecentFiles` which is O(n log n).
 */
export class FileCache {
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly now: () => number;
  private readonly entries: Map<string, Entry> = new Map();
  private totalBytes = 0;

  constructor(options: FileCacheOptions = {}) {
    this.maxEntries = options.maxEntries ?? DEFAULT_FILE_CACHE_MAX_ENTRIES;
    this.maxBytes = options.maxBytes ?? DEFAULT_FILE_CACHE_MAX_BYTES;
    this.now = options.now ?? Date.now;
  }

  /** Number of cached files. */
  get size(): number {
    return this.entries.size;
  }

  /** Cumulative bytes of cached files. */
  get bytes(): number {
    return this.totalBytes;
  }

  /**
   * Return the cached entry for `path`, refreshing its LRU position. The
   * returned object is a defensive copy so callers cannot mutate the
   * cache through it.
   */
  get(path: string): CachedFile | undefined {
    const entry = this.entries.get(path);
    if (entry === undefined) return undefined;
    const refreshed: Entry = { ...entry, lastUsedAt: this.now() };
    this.entries.delete(path);
    this.entries.set(path, refreshed);
    return refreshed;
  }

  /**
   * Insert (or replace) a cache entry. Triggers eviction when either
   * `maxEntries` or `maxBytes` is exceeded. Replaces use the new payload
   * but the same key.
   */
  set(path: string, content: string, options: { readonly bytes?: number; readonly mtimeMs?: number } = {}): void {
    const bytes = options.bytes ?? Buffer.byteLength(content, 'utf-8');
    const mtimeMs = options.mtimeMs ?? 0;
    const prior = this.entries.get(path);
    if (prior !== undefined) {
      this.totalBytes -= prior.bytes;
      this.entries.delete(path);
    }
    const entry: Entry = { path, content, bytes, mtimeMs, lastUsedAt: this.now() };
    this.entries.set(path, entry);
    this.totalBytes += bytes;
    this.evict();
  }

  /** Remove a single entry from the cache. */
  invalidate(path: string): void {
    const entry = this.entries.get(path);
    if (entry === undefined) return;
    this.totalBytes -= entry.bytes;
    this.entries.delete(path);
  }

  /** Empty the cache. */
  clear(): void {
    this.entries.clear();
    this.totalBytes = 0;
  }

  /**
   * Return the `n` most-recently-used paths, newest first. Returns fewer
   * than `n` when the cache holds fewer entries.
   */
  getRecentFiles(n: number): string[] {
    if (n <= 0 || this.entries.size === 0) return [];
    const all = Array.from(this.entries.values()).sort(
      (a, b) => b.lastUsedAt - a.lastUsedAt,
    );
    return all.slice(0, Math.min(n, all.length)).map((e) => e.path);
  }

  /** Return a snapshot of every cached entry (for tests / debugging). */
  snapshot(): readonly CachedFile[] {
    return Array.from(this.entries.values()).map((e) => ({ ...e }));
  }

  // -- Internals ---------------------------------------------------------

  private evict(): void {
    while (this.entries.size > this.maxEntries || this.totalBytes > this.maxBytes) {
      // The Map preserves insertion order; the first key is the LRU.
      const oldestKey = this.entries.keys().next().value;
      if (typeof oldestKey !== 'string') break;
      const oldest = this.entries.get(oldestKey);
      if (oldest === undefined) {
        this.entries.delete(oldestKey);
        continue;
      }
      this.totalBytes -= oldest.bytes;
      this.entries.delete(oldestKey);
    }
  }
}

/** Factory that creates a fresh {@link FileCache}. */
export function createFileCache(options: FileCacheOptions = {}): FileCache {
  return new FileCache(options);
}
