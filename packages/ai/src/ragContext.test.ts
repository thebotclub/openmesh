import { describe, it, expect } from "vitest";
import type { ObservationEvent } from "@openmesh/core";
import type { Checkpoint } from "@openmesh/core";
import { RAGContextBuilder, buildMeshContext } from "./ragContext.js";

// ── Helpers ─────────────────────────────────────────────────────────

function makeEvent(overrides: Partial<ObservationEvent> = {}): ObservationEvent {
  return {
    id: "evt-1",
    type: "github.ci.failed",
    timestamp: "2025-01-15T10:00:00.000Z",
    source: "github",
    payload: { branch: "main", run: 42 },
    ...overrides,
  };
}

function makeCheckpoint(overrides: Partial<Checkpoint> = {}): Checkpoint {
  return {
    seq: 1,
    timestamp: "2025-01-15T10:01:00.000Z",
    kind: "step_completed",
    goalId: "ci-fix",
    stepLabel: "investigate",
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────────────

describe("RAGContextBuilder", () => {
  describe("addEvents", () => {
    it("includes recent events in context", () => {
      const ctx = new RAGContextBuilder()
        .addEvents([makeEvent(), makeEvent({ id: "evt-2", type: "github.push" })])
        .build();

      expect(ctx).toContain("## Recent Events");
      expect(ctx).toContain("github.ci.failed");
      expect(ctx).toContain("github.push");
    });

    it("respects maxEvents limit", () => {
      const events = Array.from({ length: 30 }, (_, i) =>
        makeEvent({ id: `evt-${i}`, type: `test.event.${i}` }),
      );

      const ctx = new RAGContextBuilder()
        .addEvents(events, { maxEvents: 5 })
        .build();

      // Only the last 5 events should appear (indices 25-29)
      expect(ctx).toContain("test.event.25");
      expect(ctx).toContain("test.event.29");
      expect(ctx).not.toContain("test.event.0");
      expect(ctx).not.toContain("test.event.24");
    });

    it("filters by eventTypeFilter", () => {
      const events = [
        makeEvent({ id: "e1", type: "github.ci.failed" }),
        makeEvent({ id: "e2", type: "github.push" }),
        makeEvent({ id: "e3", type: "http.health.down" }),
        makeEvent({ id: "e4", type: "github.ci.passed" }),
      ];

      const ctx = new RAGContextBuilder()
        .addEvents(events, { eventTypeFilter: ["github.ci.*"] })
        .build();

      expect(ctx).toContain("github.ci.failed");
      expect(ctx).toContain("github.ci.passed");
      expect(ctx).not.toContain("github.push");
      expect(ctx).not.toContain("http.health.down");
    });

    it("handles wildcard ** in eventTypeFilter", () => {
      const events = [
        makeEvent({ id: "e1", type: "github.ci.failed" }),
        makeEvent({ id: "e2", type: "http.health.down" }),
      ];

      const ctx = new RAGContextBuilder()
        .addEvents(events, { eventTypeFilter: ["github.**"] })
        .build();

      expect(ctx).toContain("github.ci.failed");
      expect(ctx).not.toContain("http.health.down");
    });
  });

  describe("addCheckpoints", () => {
    it("includes checkpoints in context", () => {
      const ctx = new RAGContextBuilder()
        .addCheckpoints([
          makeCheckpoint(),
          makeCheckpoint({ seq: 2, kind: "goal_completed" }),
        ])
        .build();

      expect(ctx).toContain("## Execution History");
      expect(ctx).toContain("step_completed");
      expect(ctx).toContain("goal_completed");
      expect(ctx).toContain("goal=ci-fix");
    });

    it("respects maxCheckpoints limit", () => {
      const cps = Array.from({ length: 25 }, (_, i) =>
        makeCheckpoint({ seq: i, stepLabel: `step-${i}` }),
      );

      const ctx = new RAGContextBuilder()
        .addCheckpoints(cps, { maxCheckpoints: 3 })
        .build();

      expect(ctx).toContain("step=step-22");
      expect(ctx).toContain("step=step-24");
      expect(ctx).not.toContain("step=step-0");
    });

    it("includes result status when present", () => {
      const ctx = new RAGContextBuilder()
        .addCheckpoints([
          makeCheckpoint({
            result: { status: "success", summary: "done", data: {} } as any,
          }),
        ])
        .build();

      expect(ctx).toContain("status=success");
    });
  });

  describe("addGoalStates", () => {
    it("includes goal information", () => {
      const ctx = new RAGContextBuilder()
        .addGoalStates([
          { id: "goal-1", description: "Monitor CI pipeline" },
          { id: "goal-2", description: "Health checks", state: { status: "active" } },
        ])
        .build();

      expect(ctx).toContain("## Active Goals");
      expect(ctx).toContain("[goal-1] Monitor CI pipeline");
      expect(ctx).toContain("[goal-2] Health checks");
      expect(ctx).toContain('"status":"active"');
    });
  });

  describe("addCustom", () => {
    it("adds arbitrary context", () => {
      const ctx = new RAGContextBuilder()
        .addCustom("deployment", "v2.3.1 deployed to prod at 09:00")
        .build();

      expect(ctx).toContain("## Additional Context");
      expect(ctx).toContain("[deployment] v2.3.1 deployed to prod at 09:00");
    });

    it("accepts custom relevance", () => {
      const { sources } = new RAGContextBuilder()
        .addCustom("important", "critical info", 0.95)
        .buildStructured();

      expect(sources[0]!.relevance).toBe(0.95);
    });
  });

  describe("build", () => {
    it("respects maxContextChars truncation", () => {
      const ctx = new RAGContextBuilder()
        .addCustom("data", "x".repeat(500))
        .build(100);

      expect(ctx.length).toBe(100);
    });

    it("prioritizes by relevance (higher relevance sources first)", () => {
      const builder = new RAGContextBuilder()
        .addEvents([makeEvent()])            // relevance 0.5
        .addGoalStates([{ id: "g1", description: "High priority goal" }]); // relevance 0.8

      const { sources } = builder.buildStructured();
      const goalIdx = sources.findIndex((s) => s.type === "goal_state");
      const eventIdx = sources.findIndex((s) => s.type === "event");
      expect(goalIdx).toBeLessThan(eventIdx);
    });

    it("returns sections in correct order", () => {
      const ctx = new RAGContextBuilder()
        .addEvents([makeEvent()])
        .addCheckpoints([makeCheckpoint()])
        .addGoalStates([{ id: "g1", description: "Test" }])
        .addCustom("note", "hello")
        .build();

      const goalsPos = ctx.indexOf("## Active Goals");
      const historyPos = ctx.indexOf("## Execution History");
      const eventsPos = ctx.indexOf("## Recent Events");
      const customPos = ctx.indexOf("## Additional Context");

      expect(goalsPos).toBeLessThan(historyPos);
      expect(historyPos).toBeLessThan(eventsPos);
      expect(eventsPos).toBeLessThan(customPos);
    });
  });

  describe("buildStructured", () => {
    it("returns truncated flag when context is cut", () => {
      const { truncated } = new RAGContextBuilder()
        .addCustom("data", "x".repeat(500))
        .buildStructured(50);

      expect(truncated).toBe(true);
    });

    it("returns truncated=false when within limit", () => {
      const { truncated } = new RAGContextBuilder()
        .addCustom("small", "hi")
        .buildStructured(8000);

      expect(truncated).toBe(false);
    });

    it("returns all sources in sorted order", () => {
      const { sources } = new RAGContextBuilder()
        .addCustom("low", "low relevance", 0.1)
        .addCustom("high", "high relevance", 0.9)
        .buildStructured();

      expect(sources[0]!.content).toContain("high relevance");
      expect(sources[1]!.content).toContain("low relevance");
    });
  });

  describe("empty inputs", () => {
    it("produces minimal context from empty builder", () => {
      const ctx = new RAGContextBuilder().build();
      expect(ctx).toBe("");
    });

    it("handles empty event array", () => {
      const ctx = new RAGContextBuilder().addEvents([]).build();
      expect(ctx).toBe("");
    });

    it("handles empty checkpoint array", () => {
      const ctx = new RAGContextBuilder().addCheckpoints([]).build();
      expect(ctx).toBe("");
    });
  });

  describe("method chaining", () => {
    it("returns this from every add method", () => {
      const builder = new RAGContextBuilder();
      const r1 = builder.addEvents([]);
      const r2 = builder.addCheckpoints([]);
      const r3 = builder.addGoalStates([]);
      const r4 = builder.addCustom("x", "y");
      expect(r1).toBe(builder);
      expect(r2).toBe(builder);
      expect(r3).toBe(builder);
      expect(r4).toBe(builder);
    });
  });
});

describe("buildMeshContext", () => {
  it("works end-to-end with all source types", () => {
    const ctx = buildMeshContext(
      [makeEvent()],
      [makeCheckpoint()],
      [{ id: "g1", description: "Monitor CI" }],
    );

    expect(ctx).toContain("## Active Goals");
    expect(ctx).toContain("## Execution History");
    expect(ctx).toContain("## Recent Events");
    expect(ctx).toContain("Monitor CI");
    expect(ctx).toContain("github.ci.failed");
    expect(ctx).toContain("step_completed");
  });

  it("respects config options", () => {
    const events = Array.from({ length: 30 }, (_, i) =>
      makeEvent({ id: `evt-${i}`, type: `test.${i}` }),
    );

    const ctx = buildMeshContext(events, [], [], { maxEvents: 3 });
    expect(ctx).toContain("test.27");
    expect(ctx).toContain("test.29");
    expect(ctx).not.toContain("test.0");
  });

  it("respects maxContextChars", () => {
    const ctx = buildMeshContext(
      Array.from({ length: 50 }, (_, i) => makeEvent({ id: `e-${i}` })),
      [],
      [],
      { maxContextChars: 200 },
    );
    expect(ctx.length).toBeLessThanOrEqual(200);
  });
});
