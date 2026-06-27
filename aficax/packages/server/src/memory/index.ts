// C:\Users\aficado\Desktop\Aficax\aficax\packages\server\src\memory\index.ts
// Barrel re-export for the memory subsystem. Other packages only need to
// import from `@aficax/server/memory` (via the directory alias) or from
// this relative path.

export {
  AFICAX_MD_MAX_BYTES,
  MEMORY_MD_MAX_BYTES,
  MemoryStore,
  createMemoryStore,
  type MemoryFile,
  type MemoryStoreOptions,
} from './store.js';

export {
  MemoryLoader,
  createMemoryLoader,
  memoryFileExists,
  type LoadedMemory,
  type MemoryLoaderOptions,
} from './loader.js';

export {
  AutoMemoryExtractor,
  createAutoMemoryExtractor,
  type AutoMemoryCategory,
  type AutoMemoryExtractorOptions,
  type AutoMemoryLearning,
  type CommitResult,
  type ExtractorSession,
  type ExtractorToolCall,
} from './extractor.js';

export {
  FileWatcher,
  createFileWatcher,
  type WatcherChange,
  type WatcherEventKind,
  type WatcherSubscriber,
  type FileWatcherOptions,
  type WatchImpl,
} from './watcher.js';