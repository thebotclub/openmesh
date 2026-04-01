import type { EventBus, ObservationEvent } from "../events/index.js";

// ── Observer Types ──────────────────────────────────────────────────

/** Context passed to observer watch functions */
export interface ObserverContext {
  /** Emit an observation event into the mesh */
  emit: (event: ObservationEvent) => Promise<void>;
  /** Signal for graceful shutdown */
  signal: AbortSignal;
  /** Observer-scoped logger */
  log: (message: string, ...args: unknown[]) => void;
}

/** Observer definition — a persistent event source */
export interface Observer {
  /** Unique observer ID */
  id: string;
  /** Human-readable name */
  name: string;
  /** Event types this observer can emit */
  events: string[];
  /** Start watching. Called once on mesh startup. Should run until signal aborts. */
  watch: (ctx: ObserverContext) => Promise<void>;
  /** Optional cleanup on shutdown */
  dispose?: () => Promise<void>;
}

// ── Observer Registry ───────────────────────────────────────────────

export class ObserverRegistry {
  private observers = new Map<string, Observer>();
  private controllers = new Map<string, AbortController>();

  register(observer: Observer): void {
    if (this.observers.has(observer.id)) {
      throw new Error(`Observer already registered: ${observer.id}`);
    }
    this.observers.set(observer.id, observer);
  }

  /** Start all registered observers, feeding events into the bus */
  async startAll(bus: EventBus): Promise<void> {
    for (const [id, observer] of this.observers) {
      const controller = new AbortController();
      this.controllers.set(id, controller);

      const ctx: ObserverContext = {
        emit: (event) => bus.emit(event),
        signal: controller.signal,
        log: (msg, ...args) =>
          console.log(`[observer:${id}]`, msg, ...args),
      };

      // Fire and forget — observers run until aborted
      observer.watch(ctx).catch((err) => {
        if (!controller.signal.aborted) {
          console.error(`[observer:${id}] crashed:`, err);
        }
      });
    }
  }

  /** Stop all observers */
  async stopAll(): Promise<void> {
    for (const [id, controller] of this.controllers) {
      controller.abort();
      const observer = this.observers.get(id);
      await observer?.dispose?.();
    }
    this.controllers.clear();
  }

  get(id: string): Observer | undefined {
    return this.observers.get(id);
  }

  list(): Observer[] {
    return [...this.observers.values()];
  }
}
