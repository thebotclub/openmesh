/**
 * Circuit Breaker pattern for protecting operator calls.
 *
 * States: closed (healthy) → open (broken) → half_open (probing) → closed or open.
 */

export type CircuitState = "closed" | "open" | "half_open";

export interface CircuitBreakerConfig {
  /** Number of failures before opening circuit (default: 5) */
  failureThreshold?: number;
  /** Time to wait before probing (default: 30000ms) */
  cooldownMs?: number;
  /** Sliding window for failure counting (default: 60000ms) */
  monitorWindowMs?: number;
  /** Optional name for logging */
  name?: string;
}

export class CircuitOpenError extends Error {
  constructor(name: string) {
    super(`Circuit "${name}" is open — fast-failing`);
    this.name = "CircuitOpenError";
  }
}

export class CircuitBreaker {
  private _state: CircuitState = "closed";
  private failures: number[] = [];
  private openedAt = 0;
  private probing = false;

  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly monitorWindowMs: number;
  private readonly circuitName: string;

  onStateChange?: (from: CircuitState, to: CircuitState) => void;

  constructor(config?: CircuitBreakerConfig) {
    this.failureThreshold = config?.failureThreshold ?? 5;
    this.cooldownMs = config?.cooldownMs ?? 30_000;
    this.monitorWindowMs = config?.monitorWindowMs ?? 60_000;
    this.circuitName = config?.name ?? "default";
  }

  get state(): CircuitState {
    return this._state;
  }

  get failureCount(): number {
    this.pruneWindow();
    return this.failures.length;
  }

  reset(): void {
    const prev = this._state;
    this._state = "closed";
    this.failures = [];
    this.openedAt = 0;
    this.probing = false;
    if (prev !== "closed") {
      this.onStateChange?.(prev, "closed");
    }
  }

  async call<T>(fn: () => Promise<T>): Promise<T> {
    if (this._state === "open") {
      if (Date.now() - this.openedAt < this.cooldownMs) {
        throw new CircuitOpenError(this.circuitName);
      }
      // Cooldown elapsed — transition to half_open
      this.transition("half_open");
    }

    if (this._state === "half_open") {
      if (this.probing) {
        throw new CircuitOpenError(this.circuitName);
      }
      this.probing = true;
      try {
        const result = await fn();
        // Success — close circuit
        this.probing = false;
        this.failures = [];
        this.transition("closed");
        return result;
      } catch (err) {
        // Failure — reopen circuit
        this.probing = false;
        this.openedAt = Date.now();
        this.transition("open");
        throw err;
      }
    }

    // CLOSED state
    try {
      return await fn();
    } catch (err) {
      this.recordFailure();
      throw err;
    }
  }

  private recordFailure(): void {
    this.failures.push(Date.now());
    this.pruneWindow();
    if (this.failures.length >= this.failureThreshold) {
      this.openedAt = Date.now();
      this.transition("open");
    }
  }

  private pruneWindow(): void {
    const cutoff = Date.now() - this.monitorWindowMs;
    while (this.failures.length > 0 && this.failures[0]! < cutoff) {
      this.failures.shift();
    }
  }

  private transition(to: CircuitState): void {
    if (this._state === to) return;
    const from = this._state;
    this._state = to;
    this.onStateChange?.(from, to);
  }
}
