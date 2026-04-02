import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CircuitBreaker, CircuitOpenError, type CircuitState } from "../circuitBreaker.js";

describe("CircuitBreaker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Defaults ────────────────────────────────────────────────────

  it("starts in closed state", () => {
    const cb = new CircuitBreaker();
    expect(cb.state).toBe("closed");
    expect(cb.failureCount).toBe(0);
  });

  it("uses default config values", async () => {
    const cb = new CircuitBreaker();
    // Should tolerate 4 failures without opening (threshold=5)
    for (let i = 0; i < 4; i++) {
      await expect(cb.call(() => Promise.reject(new Error("fail")))).rejects.toThrow("fail");
    }
    expect(cb.state).toBe("closed");
    expect(cb.failureCount).toBe(4);
  });

  // ── Closed → Open ──────────────────────────────────────────────

  it("transitions to open after failureThreshold failures", async () => {
    const cb = new CircuitBreaker({ failureThreshold: 3 });
    for (let i = 0; i < 3; i++) {
      await expect(cb.call(() => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    }
    expect(cb.state).toBe("open");
  });

  it("re-throws the original error (not CircuitOpenError) when recording failure", async () => {
    const cb = new CircuitBreaker({ failureThreshold: 10 });
    const original = new TypeError("custom type error");
    await expect(cb.call(() => Promise.reject(original))).rejects.toBe(original);
  });

  it("success in closed state does not change state", async () => {
    const cb = new CircuitBreaker({ failureThreshold: 3 });
    const result = await cb.call(() => Promise.resolve("ok"));
    expect(result).toBe("ok");
    expect(cb.state).toBe("closed");
    expect(cb.failureCount).toBe(0);
  });

  // ── Open: fast-fail ────────────────────────────────────────────

  it("fast-fails with CircuitOpenError when open", async () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 5000 });
    await expect(cb.call(() => Promise.reject(new Error("x")))).rejects.toThrow("x");
    expect(cb.state).toBe("open");

    await expect(cb.call(() => Promise.resolve("nope"))).rejects.toThrow(CircuitOpenError);
    await expect(cb.call(() => Promise.resolve("nope"))).rejects.toThrow(/fast-failing/);
  });

  it("CircuitOpenError includes circuit name", async () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 5000, name: "myService" });
    await expect(cb.call(() => Promise.reject(new Error("x")))).rejects.toThrow();

    try {
      await cb.call(() => Promise.resolve("nope"));
    } catch (err) {
      expect(err).toBeInstanceOf(CircuitOpenError);
      expect((err as Error).message).toContain("myService");
    }
  });

  // ── Open → Half-Open → Closed (recovery) ──────────────────────

  it("transitions to half_open after cooldown, then closed on success", async () => {
    const cb = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 1000 });
    await expect(cb.call(() => Promise.reject(new Error("f")))).rejects.toThrow();
    await expect(cb.call(() => Promise.reject(new Error("f")))).rejects.toThrow();
    expect(cb.state).toBe("open");

    vi.advanceTimersByTime(1000);

    const result = await cb.call(() => Promise.resolve("recovered"));
    expect(result).toBe("recovered");
    expect(cb.state).toBe("closed");
    expect(cb.failureCount).toBe(0);
  });

  // ── Half-Open → Open (probe failure) ──────────────────────────

  it("transitions back to open when half_open probe fails", async () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 500 });
    await expect(cb.call(() => Promise.reject(new Error("f")))).rejects.toThrow();
    expect(cb.state).toBe("open");

    vi.advanceTimersByTime(500);

    await expect(cb.call(() => Promise.reject(new Error("still broken")))).rejects.toThrow("still broken");
    expect(cb.state).toBe("open");
  });

  // ── Half-Open: only one probe ─────────────────────────────────

  it("only allows one probe call in half_open, fast-fails the rest", async () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 500 });
    await expect(cb.call(() => Promise.reject(new Error("f")))).rejects.toThrow();
    expect(cb.state).toBe("open");

    vi.advanceTimersByTime(500);

    // First call triggers probe (will hang so we can test second call)
    let resolveProbe!: (v: string) => void;
    const probePromise = cb.call(
      () => new Promise<string>((resolve) => { resolveProbe = resolve; }),
    );

    // Second call should fast-fail while probe is in-flight
    await expect(cb.call(() => Promise.resolve("sneaky"))).rejects.toThrow(CircuitOpenError);

    // Resolve probe
    resolveProbe("done");
    const result = await probePromise;
    expect(result).toBe("done");
    expect(cb.state).toBe("closed");
  });

  // ── Sliding window: old failures expire ───────────────────────

  it("expires old failures outside the monitor window", async () => {
    const cb = new CircuitBreaker({ failureThreshold: 3, monitorWindowMs: 2000 });

    await expect(cb.call(() => Promise.reject(new Error("f")))).rejects.toThrow();
    await expect(cb.call(() => Promise.reject(new Error("f")))).rejects.toThrow();
    expect(cb.failureCount).toBe(2);

    // Advance past window so those failures expire
    vi.advanceTimersByTime(2001);
    expect(cb.failureCount).toBe(0);

    // Two more failures — still below threshold
    await expect(cb.call(() => Promise.reject(new Error("f")))).rejects.toThrow();
    await expect(cb.call(() => Promise.reject(new Error("f")))).rejects.toThrow();
    expect(cb.state).toBe("closed");
    expect(cb.failureCount).toBe(2);
  });

  it("does not open if failures are spread across windows", async () => {
    const cb = new CircuitBreaker({ failureThreshold: 3, monitorWindowMs: 1000 });

    await expect(cb.call(() => Promise.reject(new Error("f")))).rejects.toThrow();
    await expect(cb.call(() => Promise.reject(new Error("f")))).rejects.toThrow();
    vi.advanceTimersByTime(1001);
    await expect(cb.call(() => Promise.reject(new Error("f")))).rejects.toThrow();

    expect(cb.state).toBe("closed"); // Only 1 failure in current window
  });

  // ── Manual reset ──────────────────────────────────────────────

  it("manual reset restores to closed", async () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 60_000 });
    await expect(cb.call(() => Promise.reject(new Error("f")))).rejects.toThrow();
    expect(cb.state).toBe("open");

    cb.reset();
    expect(cb.state).toBe("closed");
    expect(cb.failureCount).toBe(0);

    // Should work again
    const result = await cb.call(() => Promise.resolve("back"));
    expect(result).toBe("back");
  });

  it("reset from closed does not fire onStateChange", () => {
    const cb = new CircuitBreaker();
    const changes: Array<[CircuitState, CircuitState]> = [];
    cb.onStateChange = (from, to) => changes.push([from, to]);
    cb.reset();
    expect(changes).toHaveLength(0);
  });

  // ── onStateChange callback ────────────────────────────────────

  it("fires onStateChange on each transition", async () => {
    const cb = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 500 });
    const changes: Array<[CircuitState, CircuitState]> = [];
    cb.onStateChange = (from, to) => changes.push([from, to]);

    // closed → open
    await expect(cb.call(() => Promise.reject(new Error("f")))).rejects.toThrow();
    await expect(cb.call(() => Promise.reject(new Error("f")))).rejects.toThrow();
    expect(changes).toEqual([["closed", "open"]]);

    // open → half_open → closed
    vi.advanceTimersByTime(500);
    await cb.call(() => Promise.resolve("ok"));
    expect(changes).toEqual([
      ["closed", "open"],
      ["open", "half_open"],
      ["half_open", "closed"],
    ]);
  });

  it("fires onStateChange on half_open → open when probe fails", async () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 200 });
    const changes: Array<[CircuitState, CircuitState]> = [];
    cb.onStateChange = (from, to) => changes.push([from, to]);

    await expect(cb.call(() => Promise.reject(new Error("f")))).rejects.toThrow();
    vi.advanceTimersByTime(200);
    await expect(cb.call(() => Promise.reject(new Error("f")))).rejects.toThrow();

    expect(changes).toEqual([
      ["closed", "open"],
      ["open", "half_open"],
      ["half_open", "open"],
    ]);
  });

  // ── Named circuits ────────────────────────────────────────────

  it("uses 'default' as circuit name when not specified", async () => {
    const cb = new CircuitBreaker({ failureThreshold: 1 });
    await expect(cb.call(() => Promise.reject(new Error("f")))).rejects.toThrow();

    try {
      await cb.call(() => Promise.resolve("nope"));
    } catch (err) {
      expect((err as Error).message).toContain("default");
    }
  });

  // ── Concurrent calls in closed state ──────────────────────────

  it("handles concurrent failures in closed state", async () => {
    const cb = new CircuitBreaker({ failureThreshold: 3 });

    const promises = Array.from({ length: 3 }, () =>
      cb.call(() => Promise.reject(new Error("concurrent fail"))).catch((e: Error) => e),
    );

    await Promise.all(promises);
    expect(cb.state).toBe("open");
  });

  it("handles concurrent successes in closed state", async () => {
    const cb = new CircuitBreaker({ failureThreshold: 3 });

    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        cb.call(() => Promise.resolve(i)),
      ),
    );

    expect(results).toEqual([0, 1, 2, 3, 4]);
    expect(cb.state).toBe("closed");
  });

  // ── Generic return type ───────────────────────────────────────

  it("preserves generic return types", async () => {
    const cb = new CircuitBreaker();

    const num = await cb.call(() => Promise.resolve(42));
    expect(num).toBe(42);

    const obj = await cb.call(() => Promise.resolve({ a: 1 }));
    expect(obj).toEqual({ a: 1 });

    const arr = await cb.call(() => Promise.resolve([1, 2, 3]));
    expect(arr).toEqual([1, 2, 3]);
  });

  // ── Failure count accuracy ────────────────────────────────────

  it("failureCount reflects sliding window accurately", async () => {
    const cb = new CircuitBreaker({ failureThreshold: 10, monitorWindowMs: 1000 });

    await expect(cb.call(() => Promise.reject(new Error("f")))).rejects.toThrow();
    expect(cb.failureCount).toBe(1);

    vi.advanceTimersByTime(400);
    await expect(cb.call(() => Promise.reject(new Error("f")))).rejects.toThrow();
    expect(cb.failureCount).toBe(2);

    // Advance so first failure expires
    vi.advanceTimersByTime(601);
    expect(cb.failureCount).toBe(1);
  });

  // ── Reset clears probing flag ─────────────────────────────────

  it("reset during half_open clears probing state", async () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 100 });
    await expect(cb.call(() => Promise.reject(new Error("f")))).rejects.toThrow();

    vi.advanceTimersByTime(100);

    // Start a probe that we won't resolve
    let resolveProbe!: (v: string) => void;
    const probePromise = cb.call(
      () => new Promise<string>((resolve) => { resolveProbe = resolve; }),
    );

    // Reset while probing
    cb.reset();
    expect(cb.state).toBe("closed");

    // Should be able to make new calls
    const result = await cb.call(() => Promise.resolve("after reset"));
    expect(result).toBe("after reset");

    // Clean up
    resolveProbe("late");
    await probePromise;
  });

  // ── Cooldown timer resets on probe failure ────────────────────

  it("resets cooldown timer after half_open probe failure", async () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 1000 });

    // Trip the circuit
    await expect(cb.call(() => Promise.reject(new Error("f")))).rejects.toThrow();
    expect(cb.state).toBe("open");

    // Wait for cooldown
    vi.advanceTimersByTime(1000);

    // Probe fails → back to open, cooldown resets
    await expect(cb.call(() => Promise.reject(new Error("still bad")))).rejects.toThrow();
    expect(cb.state).toBe("open");

    // Half the cooldown — should still be open
    vi.advanceTimersByTime(500);
    await expect(cb.call(() => Promise.resolve("too early"))).rejects.toThrow(CircuitOpenError);

    // Full cooldown from second open — should allow probe
    vi.advanceTimersByTime(500);
    const result = await cb.call(() => Promise.resolve("recovered"));
    expect(result).toBe("recovered");
    expect(cb.state).toBe("closed");
  });
});
