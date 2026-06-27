// C:\Users\aficado\Desktop\Aficax\aficax\packages\server\src\agents\index.ts
// Barrel re-export for the sub-agent subsystem.

export {
  SubAgentWorker,
  createSubAgentWorker,
  type SubAgentRunResult,
  type SubAgentWorkerDeps,
  type SubAgentWorkerOptions,
  type TaskResult,
} from './worker.js';

export {
  SubAgentSpawner,
  createSubAgentSpawner,
  type SpawnOptions,
  type SubAgentHandle,
  type SubAgentSpawnerOptions,
  type SubAgentStatus,
} from './spawner.js';

export {
  Coordinator,
  createCoordinator,
  type CoordinateOptions,
  type CoordinateTask,
  type CoordinationResult,
  type CoordinatorOptions,
} from './coordinator.js';
