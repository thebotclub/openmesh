import { describe, it, expect } from "vitest";
import { GoalEngine, type Goal } from "./index.js";
import type { ObservationEvent } from "../events/index.js";

function makeGoal(overrides: Partial<Goal> = {}): Goal {
  return {
    id: "test-goal",
    description: "A test goal",
    observe: [{ type: "ci.build.*" }],
    then: [
      { label: "investigate", operator: "code", task: "investigate the build" },
    ],
    ...overrides,
  };
}

function makeEvent(overrides: Partial<ObservationEvent> = {}): ObservationEvent {
  return {
    id: "evt-1",
    type: "ci.build.failed",
    timestamp: new Date().toISOString(),
    source: "test",
    payload: {},
    ...overrides,
  };
}

describe("GoalEngine", () => {
  it("registers and lists goals", () => {
    const engine = new GoalEngine();
    const goal = makeGoal();
    engine.register(goal);
    expect(engine.list()).toHaveLength(1);
    expect(engine.get("test-goal")).toBe(goal);
  });

  it("rejects duplicate goal registration", () => {
    const engine = new GoalEngine();
    engine.register(makeGoal());
    expect(() => engine.register(makeGoal())).toThrow("already registered");
  });

  it("matches events by type glob", () => {
    const engine = new GoalEngine();
    engine.register(makeGoal({ observe: [{ type: "ci.build.*" }] }));

    const matched = engine.matchEvent(makeEvent({ type: "ci.build.failed" }));
    expect(matched).toHaveLength(1);
    expect(matched[0]!.id).toBe("test-goal");
  });

  it("does not match unrelated events", () => {
    const engine = new GoalEngine();
    engine.register(makeGoal({ observe: [{ type: "ci.build.*" }] }));

    const matched = engine.matchEvent(makeEvent({ type: "cron.tick" }));
    expect(matched).toHaveLength(0);
  });

  it("matches events with where clauses", () => {
    const engine = new GoalEngine();
    engine.register(
      makeGoal({
        observe: [
          { type: "ci.build.*", where: { repo: "openmesh", branch: "main" } },
        ],
      }),
    );

    const yes = engine.matchEvent(
      makeEvent({ type: "ci.build.failed", payload: { repo: "openmesh", branch: "main" } }),
    );
    expect(yes).toHaveLength(1);

    const no = engine.matchEvent(
      makeEvent({ type: "ci.build.failed", payload: { repo: "other" } }),
    );
    expect(no).toHaveLength(0);
  });

  it("dedup window prevents duplicate triggers", () => {
    const engine = new GoalEngine();
    engine.register(makeGoal({ dedupWindowMs: 60_000 }));

    const event = makeEvent({ dedupKey: "build-123" });
    const first = engine.matchEvent(event);
    const second = engine.matchEvent(event);

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
  });

  it("tracks goal state", () => {
    const engine = new GoalEngine();
    engine.register(makeGoal());

    expect(engine.getState("test-goal")).toEqual({ phase: "idle" });
    engine.setState("test-goal", { phase: "matched", event: makeEvent(), matchedAt: new Date().toISOString() });
    expect(engine.getState("test-goal")!.phase).toBe("matched");
  });
});
