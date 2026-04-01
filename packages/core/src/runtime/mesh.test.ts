import { describe, it, expect, afterEach } from "vitest";
import { Mesh } from "./mesh.js";
import { MemoryWAL, type ObservationEvent } from "../events/index.js";
import type { Goal } from "../coordinators/index.js";
import type { Operator, OperatorResult } from "../operators/index.js";
import type { Observer } from "../observers/index.js";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function makeGoal(overrides: Partial<Goal> = {}): Goal {
  return {
    id: "test-goal",
    description: "Test",
    observe: [{ type: "test.*" }],
    then: [
      { label: "act", operator: "echo", task: "handle {{event.type}}" },
    ],
    ...overrides,
  };
}

function makeEchoOperator(): { operator: Operator; calls: Array<{ task: string }> } {
  const calls: Array<{ task: string }> = [];
  const operator: Operator = {
    id: "echo",
    name: "Echo Operator",
    description: "Records calls",
    execute: async (ctx) => {
      calls.push({ task: ctx.task });
      return { status: "success", summary: `Echoed: ${ctx.task}` };
    },
  };
  return { operator, calls };
}

function makeTestObserver(events: ObservationEvent[]): Observer {
  return {
    id: "test-observer",
    name: "Test Observer",
    events: ["test.*"],
    watch: async (ctx) => {
      for (const e of events) {
        if (ctx.signal.aborted) break;
        await ctx.emit(e);
      }
    },
  };
}

describe("Mesh runtime", () => {
  let tmpDir: string | undefined;

  afterEach(async () => {
    if (tmpDir && existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true });
    }
  });

  it("processes events through the goal→operator pipeline", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "openmesh-test-"));
    const mesh = new Mesh({ dataDir: tmpDir, logLevel: "error" });
    const { operator, calls } = makeEchoOperator();

    mesh
      .addOperator(operator)
      .addGoal(makeGoal());

    const event = mesh.createEvent("test.ping", "test-suite", { message: "hello" });
    await mesh.inject(event);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.task).toBe("handle test.ping");
    await mesh.stop();
  });

  it("template interpolation resolves event fields", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "openmesh-test-"));
    const mesh = new Mesh({ dataDir: tmpDir, logLevel: "error" });
    const { operator, calls } = makeEchoOperator();

    mesh
      .addOperator(operator)
      .addGoal(makeGoal({
        then: [
          { label: "act", operator: "echo", task: "source={{event.source}} type={{event.type}}" },
        ],
      }));

    const event = mesh.createEvent("test.ping", "my-source", {});
    await mesh.inject(event);

    expect(calls[0]!.task).toBe("source=my-source type=test.ping");
    await mesh.stop();
  });

  it("step results propagate via {{steps.*}} templates", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "openmesh-test-"));
    const mesh = new Mesh({ dataDir: tmpDir, logLevel: "error" });
    const { operator, calls } = makeEchoOperator();

    mesh
      .addOperator(operator)
      .addGoal(makeGoal({
        then: [
          { label: "first", operator: "echo", task: "step1" },
          { label: "second", operator: "echo", task: "prev={{steps.first.summary}}" },
        ],
      }));

    await mesh.inject(mesh.createEvent("test.x", "test", {}));

    expect(calls).toHaveLength(2);
    expect(calls[1]!.task).toBe("prev=Echoed: step1");
    await mesh.stop();
  });

  it("when conditions skip steps when condition is false", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "openmesh-test-"));
    const mesh = new Mesh({ dataDir: tmpDir, logLevel: "error" });

    const failOp: Operator = {
      id: "fail",
      name: "Fail",
      description: "Always fails",
      execute: async () => ({ status: "failure", summary: "failed" }),
    };

    const { operator: echo, calls } = makeEchoOperator();

    mesh
      .addOperator(failOp)
      .addOperator(echo)
      .addGoal(makeGoal({
        then: [
          { label: "check", operator: "fail", task: "attempt" },
          { label: "notify", operator: "echo", task: "should skip", when: "check.status == 'success'" },
        ],
      }));

    await mesh.inject(mesh.createEvent("test.x", "test", {}));

    expect(calls).toHaveLength(0); // notify was skipped
    await mesh.stop();
  });

  it("observers feed events into the mesh", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "openmesh-test-"));
    const mesh = new Mesh({ dataDir: tmpDir, logLevel: "error" });
    const { operator, calls } = makeEchoOperator();

    const testEvent: ObservationEvent = {
      id: "obs-1",
      type: "test.observed",
      timestamp: new Date().toISOString(),
      source: "test-observer",
      payload: {},
    };

    mesh
      .addObserver(makeTestObserver([testEvent]))
      .addOperator(operator)
      .addGoal(makeGoal());

    await mesh.start();
    // Give observer time to emit
    await new Promise((r) => setTimeout(r, 100));

    expect(calls).toHaveLength(1);
    expect(calls[0]!.task).toBe("handle test.observed");
    await mesh.stop();
  });

  it("unmatched events don't trigger operators", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "openmesh-test-"));
    const mesh = new Mesh({ dataDir: tmpDir, logLevel: "error" });
    const { operator, calls } = makeEchoOperator();

    mesh
      .addOperator(operator)
      .addGoal(makeGoal({ observe: [{ type: "ci.build.*" }] }));

    await mesh.inject(mesh.createEvent("cron.tick", "test", {}));

    expect(calls).toHaveLength(0);
    await mesh.stop();
  });

  it("multiple goals can match the same event", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "openmesh-test-"));
    const mesh = new Mesh({ dataDir: tmpDir, logLevel: "error" });
    const { operator, calls } = makeEchoOperator();

    mesh
      .addOperator(operator)
      .addGoal(makeGoal({ id: "goal-a" }))
      .addGoal(makeGoal({ id: "goal-b" }));

    await mesh.inject(mesh.createEvent("test.ping", "test", {}));

    expect(calls).toHaveLength(2);
    await mesh.stop();
  });

  it("createEvent generates proper event structure", () => {
    const mesh = new Mesh({ logLevel: "error" });
    const event = mesh.createEvent("my.type", "my-source", { key: "val" }, "dedup-1");

    expect(event.type).toBe("my.type");
    expect(event.source).toBe("my-source");
    expect(event.payload).toEqual({ key: "val" });
    expect(event.dedupKey).toBe("dedup-1");
    expect(event.id).toBeTruthy();
    expect(event.timestamp).toBeTruthy();
  });

  it("retries a failing step with exponential backoff", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "openmesh-test-"));
    const mesh = new Mesh({ dataDir: tmpDir, logLevel: "error" });

    let callCount = 0;
    const flaky: Operator = {
      id: "flaky",
      name: "Flaky",
      description: "Fails twice then succeeds",
      execute: async () => {
        callCount++;
        if (callCount <= 2) return { status: "failure", summary: `fail #${callCount}` };
        return { status: "success", summary: "finally passed" };
      },
    };

    mesh
      .addOperator(flaky)
      .addGoal(makeGoal({
        then: [
          {
            label: "act",
            operator: "flaky",
            task: "do something",
            retry: { maxRetries: 3, delayMs: 10, backoffMultiplier: 1 },
          },
        ],
      }));

    await mesh.inject(mesh.createEvent("test.ping", "test", {}));

    expect(callCount).toBe(3); // 1 initial + 2 retries
    const latest = mesh.state.query({ goalId: "test-goal", kind: "goal_completed" });
    expect(latest).toHaveLength(1);
    await mesh.stop();
  });

  it("stops retrying after maxRetries exhausted", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "openmesh-test-"));
    const mesh = new Mesh({ dataDir: tmpDir, logLevel: "error" });

    let callCount = 0;
    const alwaysFails: Operator = {
      id: "fail-op",
      name: "AlwaysFail",
      description: "Never succeeds",
      execute: async () => {
        callCount++;
        return { status: "failure", summary: "nope" };
      },
    };

    mesh
      .addOperator(alwaysFails)
      .addGoal(makeGoal({
        then: [
          {
            label: "act",
            operator: "fail-op",
            task: "do something",
            retry: { maxRetries: 2, delayMs: 10, backoffMultiplier: 1 },
          },
        ],
      }));

    await mesh.inject(mesh.createEvent("test.ping", "test", {}));

    expect(callCount).toBe(3); // 1 initial + 2 retries
    await mesh.stop();
  });

  it("escalation fires comms operator after N failures", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "openmesh-test-"));
    const mesh = new Mesh({ dataDir: tmpDir, logLevel: "error" });

    const commsCalls: string[] = [];
    const commsOp: Operator = {
      id: "comms",
      name: "Comms",
      description: "Records escalations",
      execute: async (ctx) => {
        commsCalls.push(ctx.task);
        return { status: "success", summary: "notified" };
      },
    };

    const failOp: Operator = {
      id: "fail-op",
      name: "Fail",
      description: "Always fails",
      execute: async () => ({ status: "failure", summary: "failed" }),
    };

    mesh
      .addOperator(commsOp)
      .addOperator(failOp)
      .addGoal(makeGoal({
        then: [
          { label: "act", operator: "fail-op", task: "break" },
        ],
        escalate: { afterFailures: 1, channel: "slack", to: "#oncall" },
      }));

    await mesh.inject(mesh.createEvent("test.ping", "test", {}));

    expect(commsCalls).toHaveLength(1);
    expect(commsCalls[0]).toMatch(/ESCALATION/);
    expect(commsCalls[0]).toMatch(/#oncall/);
    await mesh.stop();
  });
});
