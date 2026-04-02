import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startDashboard, computeMetrics } from "../server.js";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "mesh-dash-test-"));
}

/** Wait for the server to be listening by polling the port. */
function waitForServer(port: number, timeout = 3000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      if (port === 0) {
        if (Date.now() - start > timeout) return reject(new Error("Timeout waiting for server port"));
        setTimeout(check, 10);
        return;
      }
      fetch(`http://127.0.0.1:${port}/api/state`).then(() => resolve()).catch(() => {
        if (Date.now() - start > timeout) reject(new Error("Timeout waiting for server"));
        else setTimeout(check, 20);
      });
    };
    check();
  });
}

function writeWalEvents(dataDir: string, events: Record<string, unknown>[]): void {
  const lines = events.map((e) => JSON.stringify(e)).join("\n");
  writeFileSync(join(dataDir, "events.wal.jsonl"), lines, "utf-8");
}

function writeStateCheckpoints(dataDir: string, checkpoints: Record<string, unknown>[]): void {
  const lines = checkpoints.map((c) => JSON.stringify(c)).join("\n");
  writeFileSync(join(dataDir, "state.jsonl"), lines, "utf-8");
}

describe("computeMetrics", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("returns zero metrics when no data exists", () => {
    const m = computeMetrics(dataDir);
    expect(m.events.total).toBe(0);
    expect(m.events.byType).toEqual({});
    expect(m.events.recentRate).toBe(0);
    expect(m.events.timeline).toHaveLength(30);
    expect(m.goals.total).toBe(0);
    expect(m.goals.active).toBe(0);
    expect(m.goals.byStatus).toEqual({});
    expect(m.operators.total).toBe(0);
    expect(m.operators.executions).toBe(0);
    expect(m.operators.avgDurationMs).toBe(0);
    expect(m.operators.byOperator).toEqual({});
    expect(m.system.uptimeMs).toBeGreaterThan(0);
    expect(m.system.memoryMb).toBeGreaterThan(0);
    expect(m.system.eventBusSize).toBe(0);
    expect(m.system.stateCheckpoints).toBe(0);
  });

  it("counts events by type correctly", () => {
    writeWalEvents(dataDir, [
      { type: "http.request", timestamp: new Date().toISOString(), source: "api" },
      { type: "http.request", timestamp: new Date().toISOString(), source: "api" },
      { type: "db.query", timestamp: new Date().toISOString(), source: "db" },
    ]);
    const m = computeMetrics(dataDir);
    expect(m.events.total).toBe(3);
    expect(m.events.byType["http.request"]).toBe(2);
    expect(m.events.byType["db.query"]).toBe(1);
    expect(m.system.eventBusSize).toBe(3);
  });

  it("computes recent event rate from last 5 minutes", () => {
    const now = new Date();
    const recent = new Date(now.getTime() - 60_000); // 1 min ago
    const old = new Date(now.getTime() - 10 * 60_000); // 10 min ago
    writeWalEvents(dataDir, [
      { type: "a", timestamp: recent.toISOString(), source: "s" },
      { type: "a", timestamp: recent.toISOString(), source: "s" },
      { type: "a", timestamp: old.toISOString(), source: "s" },
    ]);
    const m = computeMetrics(dataDir);
    // 2 events in last 5 min → 2/5 = 0.4 per minute
    expect(m.events.recentRate).toBe(0.4);
  });

  it("computes goal status breakdown", () => {
    writeStateCheckpoints(dataDir, [
      { kind: "goal_matched", goalId: "g1", timestamp: new Date().toISOString() },
      { kind: "goal_completed", goalId: "g1", result: { status: "success" }, timestamp: new Date().toISOString() },
      { kind: "goal_matched", goalId: "g2", timestamp: new Date().toISOString() },
      { kind: "goal_failed", goalId: "g2", timestamp: new Date().toISOString() },
      { kind: "goal_matched", goalId: "g3", timestamp: new Date().toISOString() },
    ]);
    const m = computeMetrics(dataDir);
    expect(m.goals.total).toBe(3);
    expect(m.goals.active).toBe(1); // g3 still active
    expect(m.goals.byStatus["success"]).toBe(1);
    expect(m.goals.byStatus["failure"]).toBe(1);
  });

  it("computes operator execution stats", () => {
    writeStateCheckpoints(dataDir, [
      { kind: "step_completed", stepLabel: "fetch", durationMs: 100, result: { status: "success" }, timestamp: new Date().toISOString() },
      { kind: "step_completed", stepLabel: "fetch", durationMs: 200, result: { status: "success" }, timestamp: new Date().toISOString() },
      { kind: "step_completed", stepLabel: "transform", durationMs: 50, result: { status: "error" }, timestamp: new Date().toISOString() },
    ]);
    const m = computeMetrics(dataDir);
    expect(m.operators.total).toBe(2);
    expect(m.operators.executions).toBe(3);
    expect(m.operators.avgDurationMs).toBe(117); // (100+200+50)/3 = 116.67 → 117
    expect(m.operators.byOperator["fetch"]).toEqual({ executions: 2, avgMs: 150, errors: 0 });
    expect(m.operators.byOperator["transform"]).toEqual({ executions: 1, avgMs: 50, errors: 1 });
  });

  it("includes system stats", () => {
    writeWalEvents(dataDir, [{ type: "x", source: "s" }]);
    writeStateCheckpoints(dataDir, [{ kind: "step_started" }]);
    const m = computeMetrics(dataDir);
    expect(m.system.uptimeMs).toBeGreaterThan(0);
    expect(m.system.memoryMb).toBeGreaterThan(0);
    expect(m.system.eventBusSize).toBe(1);
    expect(m.system.stateCheckpoints).toBe(1);
  });

  it("timeline has 30 one-minute buckets", () => {
    const m = computeMetrics(dataDir);
    expect(m.events.timeline).toHaveLength(30);
    for (const bucket of m.events.timeline) {
      expect(bucket).toHaveProperty("time");
      expect(bucket).toHaveProperty("count");
      expect(typeof bucket.time).toBe("string");
      expect(typeof bucket.count).toBe("number");
    }
  });
});

describe("GET /api/metrics", () => {
  let dataDir: string;
  let goalsDir: string;
  let dash: { close: () => void; port: number };

  beforeEach(() => {
    dataDir = makeTmpDir();
    goalsDir = join(dataDir, "goals");
    mkdirSync(goalsDir, { recursive: true });
  });

  afterEach(() => {
    dash?.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("returns valid JSON with all expected fields", async () => {
    writeWalEvents(dataDir, [
      { type: "test", timestamp: new Date().toISOString(), source: "test" },
    ]);

    dash = startDashboard({ port: 0, dataDir, goalsDir });
    await waitForServer(dash.port);

    const res = await fetch(`http://127.0.0.1:${dash.port}/api/metrics`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");

    const m = (await res.json()) as Record<string, any>;
    expect(m).toHaveProperty("events");
    expect(m).toHaveProperty("goals");
    expect(m).toHaveProperty("operators");
    expect(m).toHaveProperty("system");

    expect(m.events).toHaveProperty("total");
    expect(m.events).toHaveProperty("byType");
    expect(m.events).toHaveProperty("recentRate");
    expect(m.events).toHaveProperty("timeline");

    expect(m.goals).toHaveProperty("total");
    expect(m.goals).toHaveProperty("active");
    expect(m.goals).toHaveProperty("byStatus");

    expect(m.operators).toHaveProperty("total");
    expect(m.operators).toHaveProperty("executions");
    expect(m.operators).toHaveProperty("avgDurationMs");
    expect(m.operators).toHaveProperty("byOperator");

    expect(m.system).toHaveProperty("uptimeMs");
    expect(m.system).toHaveProperty("memoryMb");
    expect(m.system).toHaveProperty("eventBusSize");
    expect(m.system).toHaveProperty("stateCheckpoints");
  });

  it("returns empty metrics when no data exists", async () => {
    dash = startDashboard({ port: 0, dataDir, goalsDir });
    await waitForServer(dash.port);

    const res = await fetch(`http://127.0.0.1:${dash.port}/api/metrics`);
    const m = (await res.json()) as Record<string, any>;

    expect(m.events.total).toBe(0);
    expect(m.events.byType).toEqual({});
    expect(m.goals.total).toBe(0);
    expect(m.operators.executions).toBe(0);
  });

  it("reflects WAL event data in response", async () => {
    writeWalEvents(dataDir, [
      { type: "a", timestamp: new Date().toISOString(), source: "s" },
      { type: "a", timestamp: new Date().toISOString(), source: "s" },
      { type: "b", timestamp: new Date().toISOString(), source: "s" },
    ]);
    writeStateCheckpoints(dataDir, [
      { kind: "goal_matched", goalId: "g1", timestamp: new Date().toISOString() },
      { kind: "goal_completed", goalId: "g1", result: { status: "success" }, timestamp: new Date().toISOString() },
    ]);

    dash = startDashboard({ port: 0, dataDir, goalsDir });
    await waitForServer(dash.port);

    const res = await fetch(`http://127.0.0.1:${dash.port}/api/metrics`);
    const m = (await res.json()) as Record<string, any>;

    expect(m.events.total).toBe(3);
    expect(m.events.byType["a"]).toBe(2);
    expect(m.events.byType["b"]).toBe(1);
    expect(m.goals.total).toBe(1);
    expect(m.goals.byStatus["success"]).toBe(1);
    expect(m.system.stateCheckpoints).toBe(2);
  });
});
