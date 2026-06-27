// C:\Users\aficado\Desktop\Aficax\aficax\packages\server\src\custom-agents\index.ts
// Barrel re-export for the custom-agents subsystem.

export {
  CustomAgentParser,
  createCustomAgentParser,
  parseCustomAgentFile,
  type CustomAgentDefinition,
  type CustomAgentParserOptions,
  type CustomAgentPermissionMode,
  type CustomAgentSource,
} from './parser.js';

export {
  CustomAgentRunner,
  type CustomAgentRunResult,
  type CustomAgentRunnerOptions,
} from './runner.js';
