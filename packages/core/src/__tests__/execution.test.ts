import { describe, it, expect, vi } from "vitest";
import { ExecutionEmitter, type ExecutionEvent } from "../runtime/execution.js";
import { Mesh } from "../runtime/mesh.js";
import type { ObservationEvent } from "../events/index.js";

// ── ExecutionEmitter unit tests ─────────────────────────────────────

describe("ExecutionEmitter", () => {
  it("on() returns an unsubscribe function", () => {
    const emitter = new ExecutionEmitter();
    const unsub = emitter.on(() => {});
    expect(typeof unsub).toBe("function");
  });

  it("emit() calls all listeners", () => {
    const emitter = new ExecutionEmitter();
    const calls: ExecutionEvent[] = [];
    emitter.on((e) => calls.push(e));
    emitter.on((e) => calls.push(e));

    const event: ExecutionEvent = {
      type: "goal:matched",
      timestamp: new Date().toISOString(),
      goalId: "g1",
    };
    emitter.emit(event);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toBe(event);
    expect(calls[1]).toBe(event);
  });

  it("listener errors don't crash emit", () => {
    const emitter = new ExecutionEmitter();
    emitter.on(() => { throw new Error("boom"); });
    const calls: ExecutionEvent[] = [];
    emitter.on((e) => calls.push(e));

    const event: ExecutionEvent = {
      type: "goal:matched",
      timestamp: new Date().toISOString(),
      goalId: "g1",
    };
    expect(() => emitter.emit(event)).not.toThrow();
    expect(calls).toHaveLength(1);
  });

  it("unsubscribe removes listener", () => {
    const emitter = new ExecutionEmitter();
    const calls: ExecutionEvent[] = [];
    const unsub = emitter.on((e) => calls.push(e));

    const event: ExecutionEvent = {
      type: "goal:matched",
      timestamp: new Date().toISOString(),
      goalId: "g1",
    };
    emitter.emit(event);
    expect(calls).toHaveLength(1);

    unsub();
    emitter.emit(event);
    expect(calls).toHaveLength(1); // no new call
  });

  it("size tracks active listeners", () => {
    const emitter = new ExecutionEmitter();
    expect(emitter.size).toBe(0);

    const unsub1 = emitter.on(() => {});
    expect(emitter.size).toBe(1);

    const unsub2 = emitter.on(() => {});
    expect(emitter.size).toBe(2);

    unsub1();
    expect(emitter.size).toBe(1);

    unsub2();
    expect(emitter.size).toBe(0);
  });
});

// ── Helpers for Mesh integration tests ──────────────────────────────

function createTestMesh(): Mesh {
  const mesh = new Mesh({ dataDir: "" }); // in-memory
  mesh.addOperator({
    id: "test-op",
    name: "Test",
    description: "Test operator",
    execute: async () => ({ status: "success", summary: "done" }),
  });
  mesh.addGoal({
    id: "test-goal",
    description: "Test goal",
    observe: [{ type: "test.event" }],
    then: [{ label: "step1", operator: "test-op", task: "do something" }],
  });
  return mesh;
}

function makeEvent(type = "test.event"): ObservationEvent {
  return {
    id: "evt-1",
    type,
    timestamp: new Date().toISOString(),
    source: "test",
    payload: {},
  };
}

// ── Mesh integration tests ──────────────────────────────────────────

describe("Mesh execution events", () => {
  it("goal:matched event emitted when goal matches", async () => {
    const mesh = createTestMesh();
    const events: ExecutionEvent[] = [];
    mesh.execution.on((e) => events.push(e));

    await mesh.inject(makeEvent());
    const matched = events.find((e) => e.type === "goal:matched");
    expect(matched).toBeDefined();
    expect(matched!.goalId).toBe("test-goal");
  });

  it("step:started event emitted before operator runs", async () => {
    const mesh = createTestMesh();
    const events: ExecutionEvent[] = [];
    mesh.execution.on((e) => events.push(e));

    await mesh.inject(makeEvent());
    const started = events.find((e) => e.type === "step:started");
    expect(started).toBeDefined();
    expect(started!.stepLabel).toBe("step1");
    expect(started!.stepIndex).toBe(0);
    expect(started!.totalSteps).toBe(1);
  });

  it("step:completed event with result after operator finishes", async () => {
    const mesh = createTestMesh();
    const events: ExecutionEvent[] = [];
    mesh.execution.on((e) => events.push(e));

    await mesh.inject(makeEvent());
    const completed = events.find((e) => e.type === "step:completed");
    expect(completed).toBeDefined();
    expect(completed!.result).toBeDefined();
    expect(completed!.result!.status).toBe("success");
    expect(completed!.result!.summary).toBe("done");
  });

  it("goal:completed event after all steps", async () => {
    const mesh = createTestMesh();
    const events: ExecutionEvent[] = [];
    mesh.execution.on((e) => events.push(e));

    await mesh.inject(makeEvent());
    const goalCompleted = events.find((e) => e.type === "goal:completed");
    expect(goalCompleted).toBeDefined();
    expect(goalCompleted!.goalId).toBe("test-goal");
  });

  it("step:skipped event when condition not met", async () => {
    const mesh = new Mesh({ dataDir: "" });
    mesh.addOperator({
      id: "op-a",
      name: "A",
      description: "A",
      execute: async () => ({ status: "failure", summary: "failed" }),
    });
    mesh.addOperator({
      id: "op-b",
      name: "B",
      description: "B",
      execute: async () => ({ status: "success", summary: "ok" }),
    });
    mesh.addGoal({
      id: "cond-goal",
      description: "Conditional goal",
      observe: [{ type: "cond.event" }],
      then: [
        { label: "first", operator: "op-a", task: "run first" },
        { label: "second", operator: "op-b", task: "run second", when: "first.status == 'success'" },
      ],
    });

    const events: ExecutionEvent[] = [];
    mesh.execution.on((e) => events.push(e));

    await mesh.inject(makeEvent("cond.event"));
    const skipped = events.find((e) => e.type === "step:skipped");
    expect(skipped).toBeDefined();
    expect(skipped!.stepLabel).toBe("second");
    expect(skipped!.reason).toContain("Condition not met");
  });

  it("events have correct goalId and stepLabel", async () => {
    const mesh = createTestMesh();
    const events: ExecutionEvent[] = [];
    mesh.execution.on((e) => events.push(e));

    await mesh.inject(makeEvent());
    for (const e of events) {
      expect(e.goalId).toBe("test-goal");
    }
    const stepEvents = events.filter((e) => e.stepLabel !== undefined);
    for (const e of stepEvents) {
      expect(e.stepLabel).toBe("step1");
    }
  });

  it("events have timestamps", async () => {
    const mesh = createTestMesh();
    const events: ExecutionEvent[] = [];
    mesh.execution.on((e) => events.push(e));

    await mesh.inject(makeEvent());
    for (const e of events) {
      expect(e.timestamp).toBeDefined();
      expect(typeof e.timestamp).toBe("string");
      // Valid ISO date
      expect(new Date(e.timestamp).toISOString()).toBe(e.timestamp);
    }
  });

  it("multiple listeners receive same events", async () => {
    const mesh = createTestMesh();
    const events1: ExecutionEvent[] = [];
    const events2: ExecutionEvent[] = [];
    mesh.execution.on((e) => events1.push(e));
    mesh.execution.on((e) => events2.push(e));

    await mesh.inject(makeEvent());
    expect(events1.length).toBeGreaterThan(0);
    expect(events1.length).toBe(events2.length);
    for (let i = 0; i < events1.length; i++) {
      expect(events1[i]!.type).toBe(events2[i]!.type);
    }
  });

  it("events emitted in correct order (matched → started → completed → goal:completed)", async () => {
    const mesh = createTestMesh();
    const types: string[] = [];
    mesh.execution.on((e) => types.push(e.type));

    await mesh.inject(makeEvent());
    expect(types).toEqual([
      "goal:matched",
      "step:started",
      "step:completed",
      "goal:completed",
    ]);
  });

  it("RBAC denial emits step:completed with failure result", async () => {
    const mesh = new Mesh({
      dataDir: "",
      rbac: {
        enabled: true,
        principals: [{ id: "restricted", roles: ["viewer"] }],
        roles: [{
          id: "viewer",
          permissions: [{ resource: "event:*", actions: ["inject"] }],
        }],
      },
    });
    mesh.addOperator({
      id: "secure-op",
      name: "Secure",
      description: "Restricted operator",
      execute: async () => ({ status: "success", summary: "should not run" }),
    });
    mesh.addGoal({
      id: "rbac-goal",
      description: "RBAC test goal",
      observe: [{ type: "rbac.event" }],
      then: [{ label: "restricted-step", operator: "secure-op", task: "do restricted thing" }],
    });

    const events: ExecutionEvent[] = [];
    mesh.execution.on((e) => events.push(e));

    // Inject as "restricted" principal who can inject but can't execute operators
    await mesh.inject({
      id: "evt-rbac",
      type: "rbac.event",
      timestamp: new Date().toISOString(),
      source: "test",
      payload: { principalId: "restricted" },
    }, "restricted");

    const completed = events.find((e) => e.type === "step:completed");
    expect(completed).toBeDefined();
    expect(completed!.result).toBeDefined();
    expect(completed!.result!.status).toBe("failure");
    expect(completed!.result!.summary).toContain("RBAC denied");
  });

  it("unsubscribing stops receiving events", async () => {
    const mesh = createTestMesh();
    const events: ExecutionEvent[] = [];
    const unsub = mesh.execution.on((e) => events.push(e));

    await mesh.inject(makeEvent());
    const count = events.length;
    expect(count).toBeGreaterThan(0);

    unsub();
    await mesh.inject({
      ...makeEvent(),
      id: "evt-2",
    });
    expect(events.length).toBe(count);
  });

  it("multi-step goal emits events for each step", async () => {
    const mesh = new Mesh({ dataDir: "" });
    mesh.addOperator({
      id: "op-x",
      name: "X",
      description: "X",
      execute: async () => ({ status: "success", summary: "x done" }),
    });
    mesh.addOperator({
      id: "op-y",
      name: "Y",
      description: "Y",
      execute: async () => ({ status: "success", summary: "y done" }),
    });
    mesh.addGoal({
      id: "multi-goal",
      description: "Multi-step goal",
      observe: [{ type: "multi.event" }],
      then: [
        { label: "stepA", operator: "op-x", task: "task A" },
        { label: "stepB", operator: "op-y", task: "task B" },
      ],
    });

    const events: ExecutionEvent[] = [];
    mesh.execution.on((e) => events.push(e));

    await mesh.inject(makeEvent("multi.event"));

    const types = events.map((e) => e.type);
    expect(types).toEqual([
      "goal:matched",
      "step:started",
      "step:completed",
      "step:started",
      "step:completed",
      "goal:completed",
    ]);
    const starts = events.filter((e) => e.type === "step:started");
    expect(starts[0]!.stepLabel).toBe("stepA");
    expect(starts[0]!.stepIndex).toBe(0);
    expect(starts[0]!.totalSteps).toBe(2);
    expect(starts[1]!.stepLabel).toBe("stepB");
    expect(starts[1]!.stepIndex).toBe(1);
  });
});
