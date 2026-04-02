/**
 * HookManager — Plugin lifecycle hooks for the OpenMesh runtime.
 *
 * Allows plugins to register handlers that fire at key points in the
 * pipeline: before/after goal execution, before/after operator execution,
 * on plugin loaded, and on error.
 *
 * Inspired by OpenClaw's plugin hook system.
 */

export type HookPoint =
  | "before:goal:execute"
  | "after:goal:execute"
  | "before:operator:execute"
  | "after:operator:execute"
  | "on:plugin:loaded"
  | "on:error";

export interface HookContext {
  /** Hook point being fired */
  hook: HookPoint;
  /** Timestamp when the hook fired */
  timestamp: string;
  /** Arbitrary data passed to the hook */
  data: Record<string, unknown>;
  /** Set to true by a hook handler to cancel the operation (only for before: hooks) */
  cancelled?: boolean;
  /** Reason for cancellation */
  cancelReason?: string;
}

export type HookHandler = (ctx: HookContext) => void | Promise<void>;

export interface HookRegistration {
  /** Plugin that registered this hook */
  pluginName: string;
  /** Hook point */
  hook: HookPoint;
  /** Handler function */
  handler: HookHandler;
  /** Priority (lower fires first, default 100) */
  priority?: number;
}

export class HookManager {
  private hooks = new Map<HookPoint, HookRegistration[]>();

  /**
   * Register a hook handler.
   */
  register(registration: HookRegistration): void {
    const list = this.hooks.get(registration.hook) ?? [];
    list.push(registration);
    // Sort by priority (lower first)
    list.sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));
    this.hooks.set(registration.hook, list);
  }

  /**
   * Remove all hooks for a plugin.
   */
  unregister(pluginName: string): void {
    for (const [hook, list] of this.hooks) {
      const filtered = list.filter((r) => r.pluginName !== pluginName);
      if (filtered.length > 0) {
        this.hooks.set(hook, filtered);
      } else {
        this.hooks.delete(hook);
      }
    }
  }

  /**
   * Fire all handlers for a hook point.
   * Returns the context (which may have cancelled=true for before: hooks).
   * Handlers fire in priority order. Errors in handlers are isolated — they
   * don't prevent other handlers from running. Errors are collected and returned.
   */
  async fire(
    hook: HookPoint,
    data: Record<string, unknown>,
  ): Promise<{ ctx: HookContext; errors: Error[] }> {
    const ctx: HookContext = {
      hook,
      timestamp: new Date().toISOString(),
      data,
    };

    const errors: Error[] = [];
    const list = this.hooks.get(hook) ?? [];

    for (const registration of list) {
      // If a before: hook was cancelled, stop firing remaining handlers
      if (ctx.cancelled && hook.startsWith("before:")) break;

      try {
        await registration.handler(ctx);
      } catch (err) {
        errors.push(err instanceof Error ? err : new Error(String(err)));
      }
    }

    return { ctx, errors };
  }

  /**
   * List all registered hooks.
   */
  list(): HookRegistration[] {
    const all: HookRegistration[] = [];
    for (const list of this.hooks.values()) {
      all.push(...list);
    }
    return all;
  }

  /**
   * List hooks for a specific hook point.
   */
  listFor(hook: HookPoint): HookRegistration[] {
    return [...(this.hooks.get(hook) ?? [])];
  }

  /**
   * Clear all hooks.
   */
  clear(): void {
    this.hooks.clear();
  }
}
