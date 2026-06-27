// C:\Users\aficado\Desktop\Aficax\aficax\packages\server\src\indexer\index.ts
// Barrel re-export for the indexer subsystem.

export {
  IgnoreHandler,
  createIgnoreHandler,
  pathSeparator,
  type IgnoreHandlerOptions,
} from './ignore.js';

export {
  DEFAULT_FILE_CACHE_MAX_BYTES,
  DEFAULT_FILE_CACHE_MAX_ENTRIES,
  FileCache,
  createFileCache,
  type CachedFile,
  type FileCacheOptions,
} from './file-cache.js';

export {
  RipgrepSearcher,
  buildRgArgs,
  createRipgrepSearcher,
  defaultRgSpawn,
  detectRgBinary,
  parseNullSeparated,
  probeRg,
  type RgChild,
  type RipgrepMatch,
  type RipgrepSearcherOptions,
  type RipgrepSearchOptions,
} from './ripgrep.js';

export {
  PARSER_MAX_FILE_BYTES,
  SymbolParser,
  createSymbolParser,
  type FileSymbols,
  type SupportedLanguage,
  type SymbolEntry,
  type SymbolKind,
  type SymbolParserOptions,
} from './tree-sitter.js';

export {
  RepoMap,
  createRepoMap,
  type RepoMapLine,
  type RepoMapOptions,
} from './repo-map.js';
