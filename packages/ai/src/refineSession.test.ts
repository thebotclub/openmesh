// @ts-nocheck — test file uses dynamic mocks with loose types
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock OpenAI SDK ────────────────────────────────────────────────

const mockCreate = vi.fn();

vi.mock("openai", () => {
  return {
    default: class OpenAI {
      chat = { completions: { create: mockCreate } };
      constructor(_opts?: unknown) {}
    },
  };
});

import { RefineSession } from "./refineSession.js";

// ── Helpers ─────────────────────────────────────────────────────────

function chatResult(content: string) {
  return { choices: [{ message: { content } }] };
}

function makeInterpretedGoal(overrides?: Record<string, unknown>) {
  return {
    goal: {
      id: "ci-fix",
      description: "When CI fails, investigate and notify",
      observe: [{ type: "github.ci.failed" }],
      then: [
        { label: "investigate", operator: "code", task: "Analyze the failure" },
        { label: "notify", operator: "comms", task: "Notify the team" },
      ],
    },
    explanation: "Watches CI and auto-investigates",
    confidence: 0.85,
    ...overrides,
  };
}

function makeRefinedGoal() {
  return {
    goal: {
      id: "ci-fix",
      description: "When CI fails, investigate, fix, and notify",
      observe: [{ type: "github.ci.failed" }],
      then: [
        { label: "investigate", operator: "code", task: "Analyze the failure" },
        { label: "fix", operator: "code", task: "Attempt automatic fix" },
        { label: "notify", operator: "comms", task: "Notify the team" },
      ],
    },
    explanation: "Added auto-fix step",
    confidence: 0.92,
  };
}

// ── RefineSession ───────────────────────────────────────────────────

describe("RefineSession", () => {
  beforeEach(() => mockCreate.mockReset());

  it("getCurrentGoal() returns null before start", () => {
    const session = new RefineSession();
    expect(session.getCurrentGoal()).toBeNull();
  });

  it("start() returns an InterpretedGoal with valid goal", async () => {
    const interpreted = makeInterpretedGoal();
    mockCreate.mockResolvedValueOnce(chatResult(JSON.stringify(interpreted)));

    const session = new RefineSession();
    const result = await session.start("When CI fails, investigate and notify");

    expect(result.goal.id).toBe("ci-fix");
    expect(result.goal.observe).toHaveLength(1);
    expect(result.goal.then).toHaveLength(2);
    expect(result.confidence).toBe(0.85);
    expect(result.explanation).toBe("Watches CI and auto-investigates");
  });

  it("getCurrentGoal() returns goal after start", async () => {
    mockCreate.mockResolvedValueOnce(chatResult(JSON.stringify(makeInterpretedGoal())));

    const session = new RefineSession();
    await session.start("When CI fails, investigate");

    const goal = session.getCurrentGoal();
    expect(goal).not.toBeNull();
    expect(goal!.id).toBe("ci-fix");
  });

  it("start() tracks history", async () => {
    mockCreate.mockResolvedValueOnce(chatResult(JSON.stringify(makeInterpretedGoal())));

    const session = new RefineSession();
    await session.start("When CI fails, investigate");

    const history = session.getHistory();
    expect(history).toHaveLength(2);
    expect(history[0]).toEqual({ role: "user", content: "When CI fails, investigate" });
    expect(history[1]!.role).toBe("assistant");
    expect(history[1]!.content).toContain("85%");
  });

  it("refine() uses the interpreter refine method and updates goal", async () => {
    // First call: start
    mockCreate.mockResolvedValueOnce(chatResult(JSON.stringify(makeInterpretedGoal())));
    // Second call: refine
    mockCreate.mockResolvedValueOnce(chatResult(JSON.stringify(makeRefinedGoal())));

    const session = new RefineSession();
    await session.start("When CI fails, investigate");
    const result = await session.refine("Add an auto-fix step");

    expect(result.goal.then).toHaveLength(3);
    expect(result.goal.description).toBe("When CI fails, investigate, fix, and notify");
    expect(result.confidence).toBe(0.92);
  });

  it("refine() throws if called before start", async () => {
    const session = new RefineSession();
    await expect(session.refine("feedback")).rejects.toThrow("No active goal");
  });

  it("refine() updates currentGoal", async () => {
    mockCreate.mockResolvedValueOnce(chatResult(JSON.stringify(makeInterpretedGoal())));
    mockCreate.mockResolvedValueOnce(chatResult(JSON.stringify(makeRefinedGoal())));

    const session = new RefineSession();
    await session.start("When CI fails, investigate");
    await session.refine("Add auto-fix");

    const goal = session.getCurrentGoal();
    expect(goal!.then).toHaveLength(3);
    expect(goal!.then[1]!.label).toBe("fix");
  });

  it("getHistory() includes all turns from start and refine", async () => {
    mockCreate.mockResolvedValueOnce(chatResult(JSON.stringify(makeInterpretedGoal())));
    mockCreate.mockResolvedValueOnce(chatResult(JSON.stringify(makeRefinedGoal())));

    const session = new RefineSession();
    await session.start("initial request");
    await session.refine("add more steps");

    const history = session.getHistory();
    expect(history).toHaveLength(4);
    expect(history[0]!.role).toBe("user");
    expect(history[1]!.role).toBe("assistant");
    expect(history[2]!.role).toBe("user");
    expect(history[3]!.role).toBe("assistant");
    expect(history[2]!.content).toBe("add more steps");
  });

  it("toYaml() returns empty string before start", () => {
    const session = new RefineSession();
    expect(session.toYaml()).toBe("");
  });

  it("toYaml() outputs goal in YAML format", async () => {
    mockCreate.mockResolvedValueOnce(chatResult(JSON.stringify(makeInterpretedGoal())));

    const session = new RefineSession();
    await session.start("When CI fails");

    const yaml = session.toYaml();
    expect(yaml).toContain("id: ci-fix");
    expect(yaml).toContain("description: When CI fails, investigate and notify");
    expect(yaml).toContain("observe:");
    expect(yaml).toContain('  - type: "github.ci.failed"');
    expect(yaml).toContain("then:");
    expect(yaml).toContain("  - label: investigate");
    expect(yaml).toContain('    task: "Analyze the failure"');
  });

  it("toYaml() includes escalate and dedupWindowMs when present", async () => {
    const interpreted = makeInterpretedGoal();
    interpreted.goal.escalate = { afterFailures: 3, channel: "slack", to: "#oncall" };
    interpreted.goal.dedupWindowMs = 60000;
    mockCreate.mockResolvedValueOnce(chatResult(JSON.stringify(interpreted)));

    const session = new RefineSession();
    await session.start("goal with escalation");

    const yaml = session.toYaml();
    expect(yaml).toContain("escalate:");
    expect(yaml).toContain("afterFailures: 3");
    expect(yaml).toContain('to: "#oncall"');
    expect(yaml).toContain("dedupWindowMs: 60000");
  });

  it("constructor accepts model config", async () => {
    mockCreate.mockResolvedValueOnce(chatResult(JSON.stringify(makeInterpretedGoal())));

    const session = new RefineSession({ model: "llama3" });
    await session.start("test");

    // Verify the model was passed through to the OpenAI call
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ model: "llama3" }),
    );
  });
});
