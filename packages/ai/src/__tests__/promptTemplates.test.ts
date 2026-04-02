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

import {
  PromptTemplateRegistry,
  type PromptTemplate,
  type PromptDomain,
  type PromptType,
} from "../promptTemplates.js";
import { GoalInterpreter } from "../goalInterpreter.js";
import { AIEngine } from "../engine.js";

// ── Helpers ─────────────────────────────────────────────────────────

function chatResult(content: string) {
  return { choices: [{ message: { content } }] };
}

const ALL_DOMAINS: PromptDomain[] = ["devops", "security", "observability", "data", "web", "general"];
const ALL_TYPES: PromptType[] = ["interpret", "plan", "analyze", "refine", "diagnose"];

// ── PromptTemplateRegistry ─────────────────────────────────────────

describe("PromptTemplateRegistry", () => {
  let registry: PromptTemplateRegistry;

  beforeEach(() => {
    registry = new PromptTemplateRegistry();
  });

  // ─ Coverage: all domain × type combinations exist ─

  it("has templates for all domain × type combinations (30 total)", () => {
    const templates = registry.list();
    expect(templates.length).toBeGreaterThanOrEqual(30);

    for (const domain of ALL_DOMAINS) {
      for (const type of ALL_TYPES) {
        const t = registry.get(domain, type);
        expect(t).toBeDefined();
        expect(t.domain).toBe(domain);
        expect(t.type).toBe(type);
      }
    }
  });

  // ─ get() ─

  it("get() returns correct template for domain+type", () => {
    const t = registry.get("devops", "interpret");
    expect(t.domain).toBe("devops");
    expect(t.type).toBe("interpret");
    expect(t.systemPrompt).toContain("CI/CD");
  });

  it("get() throws for unknown combination", () => {
    expect(() => registry.get("unknown" as PromptDomain, "interpret")).toThrow(
      /No template for domain="unknown"/,
    );
  });

  // ─ getWithFallback() ─

  it("getWithFallback() returns domain template when available", () => {
    const t = registry.getWithFallback("security", "analyze");
    expect(t.domain).toBe("security");
    expect(t.type).toBe("analyze");
  });

  it("getWithFallback() falls back to general for undefined domain", () => {
    const t = registry.getWithFallback(undefined, "interpret");
    expect(t.domain).toBe("general");
    expect(t.type).toBe("interpret");
  });

  it("getWithFallback() falls back to general for unknown domain", () => {
    const t = registry.getWithFallback("nonexistent" as PromptDomain, "plan");
    expect(t.domain).toBe("general");
    expect(t.type).toBe("plan");
  });

  // ─ detectDomain() ─

  describe("detectDomain()", () => {
    it("classifies 'deploy to kubernetes' as devops", () => {
      expect(registry.detectDomain("deploy to kubernetes")).toBe("devops");
    });

    it("classifies 'deploy the container to k8s with helm' as devops", () => {
      expect(registry.detectDomain("deploy the container to k8s with helm")).toBe("devops");
    });

    it("classifies 'detect brute force login attempts' as security", () => {
      expect(registry.detectDomain("detect brute force login attempts")).toBe("security");
    });

    it("classifies 'vulnerability scan and compliance audit' as security", () => {
      expect(registry.detectDomain("vulnerability scan and compliance audit")).toBe("security");
    });

    it("classifies 'SLO violation alert on error budget' as observability", () => {
      expect(registry.detectDomain("SLO violation alert on error budget")).toBe("observability");
    });

    it("classifies 'prometheus grafana dashboard monitoring' as observability", () => {
      expect(registry.detectDomain("prometheus grafana dashboard monitoring")).toBe("observability");
    });

    it("classifies 'ETL pipeline failure in data warehouse' as data", () => {
      expect(registry.detectDomain("ETL pipeline failure in data warehouse")).toBe("data");
    });

    it("classifies 'schema drift in the data lake' as data", () => {
      expect(registry.detectDomain("schema drift in the data lake")).toBe("data");
    });

    it("classifies 'API response time degradation' as web", () => {
      expect(registry.detectDomain("API response time degradation")).toBe("web");
    });

    it("classifies 'REST endpoint returns 5xx errors with CORS issues' as web", () => {
      expect(registry.detectDomain("REST endpoint returns 5xx errors with CORS issues")).toBe("web");
    });

    it("classifies 'something random' as general", () => {
      expect(registry.detectDomain("something random")).toBe("general");
    });

    it("classifies empty string as general", () => {
      expect(registry.detectDomain("")).toBe("general");
    });
  });

  // ─ register() ─

  it("register() can override a built-in template", () => {
    const custom: PromptTemplate = {
      domain: "devops",
      type: "interpret",
      systemPrompt: "Custom DevOps system prompt",
      userPromptTemplate: "Custom: {{description}}",
      temperature: 0.5,
    };

    registry.register(custom);
    const t = registry.get("devops", "interpret");
    expect(t.systemPrompt).toBe("Custom DevOps system prompt");
    expect(t.temperature).toBe(0.5);
  });

  it("register() can add a new domain template", () => {
    const custom: PromptTemplate = {
      domain: "general",
      type: "interpret",
      systemPrompt: "Overridden general interpret",
      userPromptTemplate: "{{description}}",
    };

    registry.register(custom);
    expect(registry.get("general", "interpret").systemPrompt).toBe("Overridden general interpret");
  });

  // ─ render() ─

  it("render() substitutes {{variables}}", () => {
    const template: PromptTemplate = {
      domain: "general",
      type: "interpret",
      systemPrompt: "",
      userPromptTemplate: "Deploy {{service}} to {{env}} in {{region}}",
    };

    const result = registry.render(template, {
      service: "api-gateway",
      env: "production",
      region: "us-east-1",
    });
    expect(result).toBe("Deploy api-gateway to production in us-east-1");
  });

  it("render() leaves unmatched placeholders as-is", () => {
    const template: PromptTemplate = {
      domain: "general",
      type: "interpret",
      systemPrompt: "",
      userPromptTemplate: "{{known}} and {{unknown}}",
    };

    const result = registry.render(template, { known: "hello" });
    expect(result).toBe("hello and {{unknown}}");
  });

  it("render() handles multiple occurrences of the same variable", () => {
    const template: PromptTemplate = {
      domain: "general",
      type: "interpret",
      systemPrompt: "",
      userPromptTemplate: "{{x}} then {{x}} again",
    };

    const result = registry.render(template, { x: "value" });
    expect(result).toBe("value then value again");
  });

  // ─ list() ─

  it("list() returns all registered templates", () => {
    const templates = registry.list();
    expect(templates.length).toBeGreaterThanOrEqual(30);
    expect(templates.every((t) => t.systemPrompt && t.userPromptTemplate)).toBe(true);
  });

  // ─ Template quality checks ─

  it("all templates have valid systemPrompt and userPromptTemplate", () => {
    for (const t of registry.list()) {
      expect(t.systemPrompt.length).toBeGreaterThan(50);
      expect(t.userPromptTemplate.length).toBeGreaterThan(0);
      expect(t.domain).toBeTruthy();
      expect(t.type).toBeTruthy();
    }
  });

  it("all non-general templates have at least one few-shot example", () => {
    for (const t of registry.list()) {
      expect(t.examples).toBeDefined();
      expect(t.examples!.length).toBeGreaterThanOrEqual(1);
      for (const ex of t.examples!) {
        expect(ex.input.length).toBeGreaterThan(0);
        expect(ex.output.length).toBeGreaterThan(0);
      }
    }
  });

  it("domain-specific templates have specialized keywords in systemPrompt", () => {
    const domainKeywords: Record<string, string[]> = {
      devops: ["CI/CD", "deploy"],
      security: ["security", "threat"],
      observability: ["SLO", "monitor", "observability"],
      data: ["pipeline", "data"],
      web: ["API", "HTTP", "web"],
    };

    for (const [domain, keywords] of Object.entries(domainKeywords)) {
      for (const type of ALL_TYPES) {
        const t = registry.get(domain as PromptDomain, type);
        const hasKeyword = keywords.some((kw) =>
          t.systemPrompt.toLowerCase().includes(kw.toLowerCase()),
        );
        expect(hasKeyword).toBe(true);
      }
    }
  });
});

// ── Integration: GoalInterpreter uses domain templates ─────────────

describe("GoalInterpreter + PromptTemplateRegistry integration", () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  it("uses devops domain template for deployment-related requests", async () => {
    mockCreate.mockResolvedValueOnce(
      chatResult(
        JSON.stringify({
          goal: {
            id: "k8s-deploy",
            description: "Deploy to kubernetes",
            observe: [{ type: "github.push" }],
            then: [{ label: "deploy", operator: "infra", task: "kubectl apply" }],
          },
          explanation: "Deploys on push",
          confidence: 0.9,
        }),
      ),
    );

    const engine = new AIEngine();
    const interpreter = new GoalInterpreter(engine);
    const result = await interpreter.interpret("deploy to kubernetes cluster");

    // Verify the system prompt used was the devops-specific one
    const call = mockCreate.mock.calls[0][0];
    expect(call.messages[0].content).toContain("CI/CD");
    expect(result.goal.id).toBe("k8s-deploy");
  });

  it("uses security domain template for security-related requests", async () => {
    mockCreate.mockResolvedValueOnce(
      chatResult(
        JSON.stringify({
          goal: {
            id: "block-brute-force",
            description: "Block brute force",
            observe: [{ type: "log.anomaly" }],
            then: [{ label: "block", operator: "infra", task: "Block IP" }],
          },
          explanation: "Blocks brute force IPs",
          confidence: 0.88,
        }),
      ),
    );

    const engine = new AIEngine();
    const interpreter = new GoalInterpreter(engine);
    const result = await interpreter.interpret("detect brute force login attacks and block the attacker");

    const call = mockCreate.mock.calls[0][0];
    expect(call.messages[0].content).toContain("security");
    expect(result.goal.id).toBe("block-brute-force");
  });

  it("falls back to general domain for unrecognized descriptions", async () => {
    mockCreate.mockResolvedValueOnce(
      chatResult(
        JSON.stringify({
          goal: {
            id: "misc-task",
            description: "Do something",
            observe: [{ type: "cron.tick" }],
            then: [{ label: "act", operator: "ai", task: "Think about it" }],
          },
          explanation: "Does something",
          confidence: 0.7,
        }),
      ),
    );

    const engine = new AIEngine();
    const interpreter = new GoalInterpreter(engine);
    const result = await interpreter.interpret("do something completely unrelated to any domain");

    const call = mockCreate.mock.calls[0][0];
    // General template should NOT contain domain-specific keywords like CI/CD or SIEM
    expect(call.messages[0].content).not.toContain("SIEM");
    expect(call.messages[0].content).not.toContain("Kubernetes");
    expect(result.goal.id).toBe("misc-task");
  });

  it("accepts a custom registry", async () => {
    const registry = new PromptTemplateRegistry();
    registry.register({
      domain: "general",
      type: "interpret",
      systemPrompt: "CUSTOM_SYSTEM_PROMPT",
      userPromptTemplate: "{{description}}",
    });

    mockCreate.mockResolvedValueOnce(
      chatResult(
        JSON.stringify({
          goal: {
            id: "custom",
            description: "Custom",
            observe: [{ type: "cron.tick" }],
            then: [{ label: "x", operator: "ai", task: "y" }],
          },
          explanation: "Custom",
          confidence: 0.9,
        }),
      ),
    );

    const engine = new AIEngine();
    const interpreter = new GoalInterpreter(engine, registry);
    await interpreter.interpret("tell me a joke about cats");

    const call = mockCreate.mock.calls[0][0];
    expect(call.messages[0].content).toContain("CUSTOM_SYSTEM_PROMPT");
  });
});
