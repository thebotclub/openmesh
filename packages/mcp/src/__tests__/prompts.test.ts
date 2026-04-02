import { describe, it, expect, vi, beforeEach } from "vitest";
import { MeshMCPServer } from "../server.js";

function createMockMesh() {
  return {
    bus: {
      getLog: vi.fn(() => [
        { id: "e1", type: "ci.build.failed", timestamp: "2025-01-01T00:00:00Z", source: "github", payload: { repo: "acme" } },
        { id: "e2", type: "deploy.succeeded", timestamp: "2025-01-01T00:05:00Z", source: "cd", payload: { env: "prod" } },
      ]),
      on: vi.fn(),
      emit: vi.fn(),
      clear: vi.fn(),
    },
    goals: {
      list: vi.fn(() => []),
      getState: vi.fn(() => ({ phase: "idle" })),
      get: vi.fn((id: string) => {
        if (id === "fix-ci") {
          return {
            id: "fix-ci",
            description: "Auto-fix CI failures",
            observe: [{ type: "ci.build.failed" }],
            then: [{ label: "analyze", operator: "llm", task: "Analyze the failure" }],
          };
        }
        return undefined;
      }),
    },
    operators: { list: vi.fn(() => []) },
    observers: { list: vi.fn(() => []) },
    state: { query: vi.fn(() => []), getSeq: vi.fn(() => 0) },
    isRunning: vi.fn(() => false),
    createEvent: vi.fn(),
    inject: vi.fn(),
  } as unknown as ConstructorParameters<typeof MeshMCPServer>[0];
}

describe("MCP Prompts", () => {
  let server: MeshMCPServer;
  let mesh: ReturnType<typeof createMockMesh>;

  beforeEach(() => {
    mesh = createMockMesh();
    server = new MeshMCPServer(mesh as any);
  });

  describe("prompts/list", () => {
    it("returns all 3 prompts", () => {
      const result = (server as any)._handleListPrompts();
      expect(result.prompts).toHaveLength(3);
      const names = result.prompts.map((p: any) => p.name);
      expect(names).toContain("create-goal");
      expect(names).toContain("analyze-events");
      expect(names).toContain("refine-goal");
    });

    it("each prompt has name, description, and arguments", () => {
      const result = (server as any)._handleListPrompts();
      for (const p of result.prompts) {
        expect(p).toHaveProperty("name");
        expect(p).toHaveProperty("description");
        expect(p).toHaveProperty("arguments");
      }
    });
  });

  describe("prompts/get — create-goal", () => {
    it("returns messages with the description interpolated", () => {
      const result = (server as any)._handleGetPrompt("create-goal", { description: "restart failing pods" });
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].role).toBe("user");
      expect(result.messages[0].content.text).toContain("restart failing pods");
      expect(result.messages[0].content.text).toContain("goal YAML");
    });

    it("handles missing description gracefully", () => {
      const result = (server as any)._handleGetPrompt("create-goal", {});
      expect(result.messages[0].content.text).toContain('""');
    });
  });

  describe("prompts/get — analyze-events", () => {
    it("returns messages including recent events", () => {
      const result = (server as any)._handleGetPrompt("analyze-events", {});
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].content.text).toContain("ci.build.failed");
      expect(result.messages[0].content.text).toContain("deploy.succeeded");
    });

    it("respects the window argument", () => {
      const result = (server as any)._handleGetPrompt("analyze-events", { window: "1" });
      expect(result.messages[0].content.text).toContain("1 recent");
      // Only the last event should appear (window=1)
      expect(result.messages[0].content.text).toContain("deploy.succeeded");
    });
  });

  describe("prompts/get — refine-goal", () => {
    it("returns messages with existing goal definition", () => {
      const result = (server as any)._handleGetPrompt("refine-goal", { goalId: "fix-ci", feedback: "add a Slack notification step" });
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].content.text).toContain("fix-ci");
      expect(result.messages[0].content.text).toContain("add a Slack notification step");
      expect(result.messages[0].content.text).toContain("Auto-fix CI failures");
    });

    it("handles unknown goalId", () => {
      const result = (server as any)._handleGetPrompt("refine-goal", { goalId: "nonexistent", feedback: "improve" });
      expect(result.messages[0].content.text).toContain("not found");
    });
  });

  describe("unknown prompt", () => {
    it("throws on unknown prompt name", () => {
      expect(() => (server as any)._handleGetPrompt("unknown-prompt", {})).toThrow("Unknown prompt: unknown-prompt");
    });
  });
});
