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

export { RBACManager, BUILTIN_ROLES } from "./rbac.js";
export type { Permission, Role, Principal, RBACConfig } from "./rbac.js";

export { AuditLog } from "./audit.js";
export type { AuditEntry, AuditConfig, AuditQueryFilter } from "./audit.js";

export { Sandbox } from "./sandbox.js";
export type { SandboxConfig, SandboxResult } from "./sandbox.js";

export { loadGoalFromYaml, loadGoalsFromDir, parseSimpleYaml } from "./goals/loader.js";

export { CircuitBreaker, CircuitOpenError } from "./circuitBreaker.js";
export type { CircuitBreakerConfig, CircuitState } from "./circuitBreaker.js";

export { ExecutionEmitter } from "./runtime/execution.js";
export type { ExecutionEvent, ExecutionEventType, ExecutionListener } from "./runtime/execution.js";

export {
  SecretsManager,
  EnvSecretBackend,
  FileSecretBackend,
  VaultSecretBackend,
  AwsSecretsBackend,
  OnePasswordBackend,
} from "./secrets/index.js";
export type {
  SecretBackend,
  SecretsManagerConfig,
  VaultConfig,
  AwsSecretsConfig,
  OnePasswordConfig,
} from "./secrets/index.js";
