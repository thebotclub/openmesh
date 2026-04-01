import type { Observer, ObserverContext } from "@openmesh/core";

/**
 * Observer definition options — passed to defineObserver().
 * Modeled on OpenClaw's defineChannelPluginEntry pattern.
 */
export interface ObserverDefinition {
  /** Unique observer ID */
  id: string;
  /** Human-readable name */
  name: string;
  /** Event types this observer can emit */
  events: string[];
  /** Start watching. Should run continuously until signal aborts. */
  watch: (ctx: ObserverContext) => Promise<void>;
  /** Optional cleanup on shutdown */
  dispose?: () => Promise<void>;
}

/**
 * Define an observer — a persistent event source.
 *
 * @example
 * ```ts
 * import { defineObserver } from "@openmesh/sdk/observer";
 *
 * export default defineObserver({
 *   id: "github",
 *   name: "GitHub Observer",
 *   events: ["github.ci.failed", "github.pr.opened"],
 *   async watch(ctx) {
 *     // Poll or listen for GitHub events
 *     // ctx.emit({ id, type, timestamp, source, payload })
 *   },
 * });
 * ```
 */
export function defineObserver(definition: ObserverDefinition): Observer {
  return {
    id: definition.id,
    name: definition.name,
    events: definition.events,
    watch: definition.watch,
    dispose: definition.dispose,
  };
}
