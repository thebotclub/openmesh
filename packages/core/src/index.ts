/**
 * @openmesh/core — runtime foundation for the OpenMesh operations platform.
 *
 * Re-exports public surface from each subsystem.
 */

export { EventBus, FileWAL, MemoryWAL, matchGlob } from "./events/index.js";
export type {
  ObservationEvent,
  EventHandler,
  EventPattern,
  WAL,
} from "./events/index.js";

export { ObserverRegistry } from "./observers/index.js";
export type { Observer, ObserverContext } from "./observers/index.js";

export { OperatorRegistry } from "./operators/index.js";
export type {
  Operator,
  OperatorContext,
  OperatorResult,
} from "./operators/index.js";

export { GoalEngine } from "./coordinators/index.js";
export type {
  Goal,
  GoalStep,
  GoalState,
  EscalationPolicy,
  RetryPolicy,
} from "./coordinators/index.js";

export { StateStore } from "./state/index.js";
export type { DurableState, Checkpoint } from "./state/index.js";

export type { PermissionRule, PermissionContext } from "./permissions/index.js";

export type { ProviderConfig } from "./providers/index.js";

export { Mesh } from "./runtime/mesh.js";
export type { MeshConfig, MeshLogger } from "./runtime/mesh.js";

export { loadGoalFromYaml, loadGoalsFromDir, parseSimpleYaml } from "./goals/loader.js";
