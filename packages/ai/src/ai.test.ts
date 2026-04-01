// @ts-nocheck — test file uses dynamic mocks with loose types
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ObservationEvent, Operator, OperatorResult } from "@openmesh/core";

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

import { AIEngine } from "./engine.js";
import { GoalInterpreter } from "./goalInterpreter.js";
import { OperatorPlanner } from "./planner.js";
import { AnomalyDetector, type Anomaly } from "./anomalyDetector.js";
import { AIOperator, createAIOperator } from "./aiOperator.js";

// ── Helpers ─────────────────────────────────────────────────────────

function chatResult(content: string) {
  return { choices: [{ message: { content } }] };
}

function makeEvent(overrides: Partial<ObservationEvent> = {}): ObservationEvent {
  return {
    id: "evt-1",
    type: "github.ci.failed",
    timestamp: new Date().toISOString(),
    source: "github",
    payload: { branch: "main", run: 42 },
    ...overrides,
  };
}

function makeGoal() {
  return {
    id: "ci-fix",
    description: "When CI fails, investigate and notify",
    observe: [{ type: "github.ci.failed" }],
    then: [
      { label: "investigate", operator: "code", task: "Analyze the failure" },
      { label: "notify", operator: "comms", task: "Notify the team" },
    ],
  };
}

function makeOperators(): Operator[] {
  return [
    { id: "code", name: "Code", description: "Analyze code", execute: vi.fn() },
    { id: "comms", name: "Comms", description: "Send notifications", execute: vi.fn() },
  ];
}

// ── AIEngine ────────────────────────────────────────────────────────

describe("AIEngine", () => {
  beforeEach(() => {
    mockCreate.mockReset();
    delete process.env["OPENMESH_LLM_API_KEY"];
    delete process.env["OPENAI_API_KEY"];
    delete process.env["OPENMESH_LLM_BASE_URL"];
    delete process.env["OPENMESH_LLM_MODEL"];
  });

  it("uses default config when none provided", () => {
    const engine = new AIEngine();
    expect(engine.config.baseUrl).toBe("http://localhost:4000/v1");
    expect(engine.config.apiKey).toBe("not-needed");
    expect(engine.config.model).toBe("gpt-4o-mini");
    expect(engine.config.temperature).toBe(0.2);
    expect(engine.config.maxTokens).toBe(4096);
  });

  it("reads API key from OPENMESH_LLM_API_KEY env var", () => {
    process.env["OPENMESH_LLM_API_KEY"] = "sk-mesh-test";
    const engine = new AIEngine();
    expect(engine.config.apiKey).toBe("sk-mesh-test");
  });

  it("falls back to OPENAI_API_KEY env var", () => {
    process.env["OPENAI_API_KEY"] = "sk-openai-test";
    const engine = new AIEngine();
    expect(engine.config.apiKey).toBe("sk-openai-test");
  });

  it("explicit config overrides env vars", () => {
    process.env["OPENMESH_LLM_API_KEY"] = "sk-env";
    const engine = new AIEngine({ apiKey: "sk-explicit", model: "llama3" });
    expect(engine.config.apiKey).toBe("sk-explicit");
    expect(engine.config.model).toBe("llama3");
  });

  it("chat() calls OpenAI completions.create with correct params", async () => {
    mockCreate.mockResolvedValueOnce(chatResult("hello"));
    const engine = new AIEngine();
    const result = await engine.chat([{ role: "user", content: "hi" }]);
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "hi" }],
        temperature: 0.2,
        max_tokens: 4096,
      }),
    );
    expect(result.choices[0]!.message.content).toBe("hello");
  });

  it("chat() forwards model and temperature overrides", async () => {
    mockCreate.mockResolvedValueOnce(chatResult("ok"));
    const engine = new AIEngine();
    await engine.chat([{ role: "user", content: "x" }], { model: "claude-3", temperature: 0.9 });
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ model: "claude-3", temperature: 0.9 }),
    );
  });

  it("prompt() returns text content from LLM", async () => {
    mockCreate.mockResolvedValueOnce(chatResult("42 is the answer"));
    const engine = new AIEngine();
    const text = await engine.prompt("system", "what is 42?");
    expect(text).toBe("42 is the answer");
  });

  it("prompt() returns empty string when content is null", async () => {
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: null } }] });
    const engine = new AIEngine();
    const text = await engine.prompt("sys", "hi");
    expect(text).toBe("");
  });

  it("promptJSON() parses JSON response", async () => {
    const data = { name: "test", value: 42 };
    mockCreate.mockResolvedValueOnce(chatResult(JSON.stringify(data)));
    const engine = new AIEngine();
    const result = await engine.promptJSON<{ name: string; value: number }>("sys", "parse");
    expect(result).toEqual(data);
  });

  it("promptJSON() requests json_object response format", async () => {
    mockCreate.mockResolvedValueOnce(chatResult("{}"));
    const engine = new AIEngine();
    await engine.promptJSON("sys", "json");
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ response_format: { type: "json_object" } }),
    );
  });
});

// ── GoalInterpreter ─────────────────────────────────────────────────

describe("GoalInterpreter", () => {
  beforeEach(() => mockCreate.mockReset());

  it("interpret() returns a valid InterpretedGoal", async () => {
    const interpreted = {
      goal: {
        id: "ci-auto-fix",
        description: "Auto-fix CI",
        observe: [{ type: "github.ci.failed" }],
        then: [{ label: "fix", operator: "code", task: "Fix the build" }],
      },
      explanation: "Watches CI and auto-fixes",
      confidence: 0.85,
    };
    mockCreate.mockResolvedValueOnce(chatResult(JSON.stringify(interpreted)));

    const engine = new AIEngine();
    const interp = new GoalInterpreter(engine);
    const result = await interp.interpret("When CI fails, fix it");

    expect(result.goal.id).toBe("ci-auto-fix");
    expect(result.goal.observe).toHaveLength(1);
    expect(result.goal.then).toHaveLength(1);
    expect(result.confidence).toBe(0.85);
  });

  it("interpret() throws when LLM returns incomplete goal", async () => {
    mockCreate.mockResolvedValueOnce(chatResult(JSON.stringify({ goal: { id: "bad" } })));

    const engine = new AIEngine();
    const interp = new GoalInterpreter(engine);
    await expect(interp.interpret("do something")).rejects.toThrow("incomplete goal definition");
  });

  it("interpret() includes context when provided", async () => {
    const interpreted = {
      goal: {
        id: "g1",
        description: "d",
        observe: [{ type: "cron.tick" }],
        then: [{ label: "s1", operator: "data", task: "query" }],
      },
      explanation: "ok",
      confidence: 0.9,
    };
    mockCreate.mockResolvedValueOnce(chatResult(JSON.stringify(interpreted)));

    const engine = new AIEngine();
    const interp = new GoalInterpreter(engine);
    await interp.interpret("check health", {
      existingGoals: ["g0"],
      existingOperators: ["code", "data"],
    });

    const userMsg = mockCreate.mock.calls[0]![0].messages[1].content;
    expect(userMsg).toBe("check health");
  });

  it("refine() sends current goal and feedback", async () => {
    const refined = {
      goal: {
        id: "ci-fix",
        description: "Updated",
        observe: [{ type: "github.ci.failed" }],
        then: [{ label: "fix", operator: "code", task: "Better fix" }],
      },
      explanation: "refined",
      confidence: 0.95,
    };
    mockCreate.mockResolvedValueOnce(chatResult(JSON.stringify(refined)));

    const engine = new AIEngine();
    const interp = new GoalInterpreter(engine);
    const result = await interp.refine(makeGoal(), "Add a verification step");

    expect(result.goal.description).toBe("Updated");
    const userMsg = mockCreate.mock.calls[0]![0].messages[1].content as string;
    expect(userMsg).toContain("Add a verification step");
    expect(userMsg).toContain("ci-fix");
  });
});

// ── OperatorPlanner ─────────────────────────────────────────────────

describe("OperatorPlanner", () => {
  beforeEach(() => mockCreate.mockReset());

  it("plan() returns an ExecutionPlan with steps", async () => {
    const plan = {
      goalId: "ci-fix",
      steps: [
        { label: "investigate", operator: "code", task: "Check logs", reasoning: "need info", estimatedDurationMs: 5000 },
        { label: "notify", operator: "comms", task: "Alert team", reasoning: "keep informed", estimatedDurationMs: 1000 },
      ],
      reasoning: "investigate first, then notify",
      estimatedTotalMs: 6000,
    };
    mockCreate.mockResolvedValueOnce(chatResult(JSON.stringify(plan)));

    const engine = new AIEngine();
    const planner = new OperatorPlanner(engine);
    const result = await planner.plan(makeGoal(), makeEvent(), makeOperators());

    expect(result.goalId).toBe("ci-fix");
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0]!.operator).toBe("code");
    expect(result.estimatedTotalMs).toBe(6000);
  });

  it("plan() includes recent results in prompt when provided", async () => {
    const plan = {
      goalId: "ci-fix",
      steps: [{ label: "retry", operator: "code", task: "Retry", reasoning: "r", estimatedDurationMs: 1000 }],
      reasoning: "adapt",
      estimatedTotalMs: 1000,
    };
    mockCreate.mockResolvedValueOnce(chatResult(JSON.stringify(plan)));

    const recentResults = new Map<string, OperatorResult>([
      ["investigate", { status: "success", summary: "Found root cause" }],
    ]);

    const engine = new AIEngine();
    const planner = new OperatorPlanner(engine);
    await planner.plan(makeGoal(), makeEvent(), makeOperators(), recentResults);

    const userMsg = mockCreate.mock.calls[0]![0].messages[1].content as string;
    expect(userMsg).toContain("Found root cause");
  });

  it("replan() generates recovery plan after failure", async () => {
    const recovery = {
      goalId: "ci-fix",
      steps: [{ label: "escalate", operator: "comms", task: "Escalate to oncall", reasoning: "auto-fix failed", estimatedDurationMs: 500 }],
      reasoning: "cannot auto-fix, escalating",
      estimatedTotalMs: 500,
    };
    mockCreate.mockResolvedValueOnce(chatResult(JSON.stringify(recovery)));

    const completedResults = new Map<string, OperatorResult>([
      ["investigate", { status: "success", summary: "Identified issue" }],
    ]);

    const engine = new AIEngine();
    const planner = new OperatorPlanner(engine);
    const result = await planner.replan(
      makeGoal(),
      makeEvent(),
      "fix",
      "Patch could not be applied",
      makeOperators(),
      completedResults,
    );

    expect(result.steps[0]!.label).toBe("escalate");
    const userMsg = mockCreate.mock.calls[0]![0].messages[1].content as string;
    expect(userMsg).toContain("Patch could not be applied");
    expect(userMsg).toContain("STEP FAILED");
  });
});

// ── AnomalyDetector ─────────────────────────────────────────────────

describe("AnomalyDetector", () => {
  beforeEach(() => mockCreate.mockReset());

  it("observe() accumulates events in window", () => {
    const engine = new AIEngine();
    const detected: Anomaly[] = [];
    const detector = new AnomalyDetector(engine, (a) => detected.push(a));

    detector.observe(makeEvent({ type: "log.error" }));
    detector.observe(makeEvent({ type: "log.error" }));
    detector.observe(makeEvent({ type: "log.warn" }));

    // Internal state check via analyze behavior — fewer than 3 events would skip
    // We added 3, so analyze should proceed (tested below)
    expect(detected).toHaveLength(0); // no anomalies until analyze() is called
  });

  it("analyze() returns empty when fewer than 3 events", async () => {
    const engine = new AIEngine();
    const detector = new AnomalyDetector(engine, vi.fn());

    detector.observe(makeEvent({ type: "a" }));
    detector.observe(makeEvent({ type: "b" }));

    const result = await detector.analyze();
    expect(result).toEqual([]);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("analyze() calls LLM and returns detected anomalies", async () => {
    const anomalies = [
      {
        type: "frequency_spike",
        severity: "high",
        description: "Error burst detected",
        relatedEvents: ["log.error"],
        suggestedAction: "Check recent deploys",
      },
    ];
    mockCreate.mockResolvedValueOnce(
      chatResult(JSON.stringify({ anomalies, summary: "error spike" })),
    );

    const engine = new AIEngine();
    const detected: Anomaly[] = [];
    const detector = new AnomalyDetector(engine, (a) => detected.push(a));

    detector.observe(makeEvent({ type: "log.error" }));
    detector.observe(makeEvent({ type: "log.error" }));
    detector.observe(makeEvent({ type: "log.error" }));

    const result = await detector.analyze();

    expect(result).toHaveLength(1);
    expect(result[0]!.type).toBe("frequency_spike");
    expect(result[0]!.detectedAt).toBeDefined();
    // onAnomaly callback should have been called
    expect(detected).toHaveLength(1);
  });

  it("analyze() returns empty when LLM finds no anomalies", async () => {
    mockCreate.mockResolvedValueOnce(
      chatResult(JSON.stringify({ anomalies: [], summary: "normal" })),
    );

    const engine = new AIEngine();
    const detector = new AnomalyDetector(engine, vi.fn());

    detector.observe(makeEvent({ type: "cron.tick" }));
    detector.observe(makeEvent({ type: "cron.tick" }));
    detector.observe(makeEvent({ type: "cron.tick" }));

    const result = await detector.analyze();
    expect(result).toEqual([]);
  });

  it("start() and stop() manage periodic analysis", () => {
    vi.useFakeTimers();
    const engine = new AIEngine();
    mockCreate.mockResolvedValue(
      chatResult(JSON.stringify({ anomalies: [], summary: "normal" })),
    );

    const detector = new AnomalyDetector(engine, vi.fn(), { analysisIntervalMs: 1000 });
    detector.observe(makeEvent({ type: "a" }));
    detector.observe(makeEvent({ type: "b" }));
    detector.observe(makeEvent({ type: "c" }));

    detector.start();
    vi.advanceTimersByTime(1000);
    expect(mockCreate).toHaveBeenCalledTimes(1);

    detector.stop();
    vi.advanceTimersByTime(5000);
    expect(mockCreate).toHaveBeenCalledTimes(1); // no more calls after stop

    vi.useRealTimers();
  });
});

// ── AIOperator ──────────────────────────────────────────────────────

describe("AIOperator", () => {
  beforeEach(() => mockCreate.mockReset());

  it("execute() returns success result with summary", async () => {
    mockCreate.mockResolvedValueOnce(
      chatResult("Root cause identified: memory leak in worker process.\nDetails: heap grew 3x in 1h."),
    );

    const engine = new AIEngine();
    const op = new AIOperator(engine);
    const result = await op.execute({
      task: "Investigate memory spike",
      event: { type: "log.error", source: "monitor" },
      signal: new AbortController().signal,
      log: vi.fn(),
      requestApproval: vi.fn(),
    });

    expect(result.status).toBe("success");
    expect(result.summary).toContain("Root cause identified");
    expect(result.data).toHaveProperty("details");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("execute() returns failure when LLM throws", async () => {
    mockCreate.mockRejectedValueOnce(new Error("API timeout"));

    const engine = new AIEngine();
    const op = new AIOperator(engine);
    const result = await op.execute({
      task: "analyze something",
      event: {},
      signal: new AbortController().signal,
      log: vi.fn(),
      requestApproval: vi.fn(),
    });

    expect(result.status).toBe("failure");
    expect(result.summary).toContain("API timeout");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("has correct operator metadata", () => {
    const engine = new AIEngine();
    const op = new AIOperator(engine);
    expect(op.id).toBe("ai");
    expect(op.name).toBe("AI Reasoning Operator");
    expect(op.description).toBeTruthy();
  });

  it("execute() handles single-line response (no details)", async () => {
    mockCreate.mockResolvedValueOnce(chatResult("All clear"));

    const engine = new AIEngine();
    const op = new AIOperator(engine);
    const result = await op.execute({
      task: "check status",
      event: {},
      signal: new AbortController().signal,
      log: vi.fn(),
      requestApproval: vi.fn(),
    });

    expect(result.status).toBe("success");
    expect(result.summary).toBe("All clear");
    expect(result.data).toHaveProperty("fullResponse");
  });
});

describe("createAIOperator", () => {
  beforeEach(() => mockCreate.mockReset());

  it("creates an AIOperator with default config", () => {
    const op = createAIOperator();
    expect(op).toBeInstanceOf(AIOperator);
    expect(op.id).toBe("ai");
  });

  it("creates an AIOperator with custom config", () => {
    const op = createAIOperator({ model: "llama3", apiKey: "test-key" });
    expect(op).toBeInstanceOf(AIOperator);
  });
});
