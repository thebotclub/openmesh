import { describe, it, expect } from "vitest";
import operator from "./index.js";

function makeCtx(task: string, requestApproval: () => Promise<boolean> = async () => true) {
  const logs: string[] = [];
  return {
    ctx: {
      task,
      event: { type: "test", source: "test", timestamp: new Date().toISOString(), data: {} },
      previousSteps: {},
      signal: new AbortController().signal,
      log: (msg: string) => logs.push(msg),
      requestApproval,
    },
    logs,
  };
}

describe("Infra Operator", () => {
  it("executes an allowed command", async () => {
    const { ctx } = makeCtx("exec: echo hello from infra");
    const result = await operator.execute(ctx);
    expect(result.status).toBe("success");
    expect(result.summary).toContain("hello from infra");
  });

  it("blocks disallowed commands", async () => {
    const { ctx } = makeCtx("exec: rm -rf /");
    const result = await operator.execute(ctx);
    expect(result.status).toBe("failure");
    expect(result.summary).toMatch(/not in allowlist/i);
  });

  it("requests approval for destructive commands", async () => {
    let approvalRequested = false;
    const { ctx } = makeCtx("exec: docker restart myapp", async () => {
      approvalRequested = true;
      return true;
    });
    const result = await operator.execute(ctx);
    expect(approvalRequested).toBe(true);
    // docker restart will fail because docker isn't running, but approval was requested
    expect(["success", "failure"]).toContain(result.status);
  });

  it("denies when approval is rejected", async () => {
    const { ctx } = makeCtx("exec: docker restart myapp", async () => false);
    const result = await operator.execute(ctx);
    expect(result.status).toBe("denied");
  });

  it("returns dry-run for non-exec tasks", async () => {
    const { ctx } = makeCtx("scale web to 5 replicas");
    const result = await operator.execute(ctx);
    expect(result.status).toBe("success");
    expect(result.summary).toMatch(/infra analysis/i);
  });

  it("allows ls command", async () => {
    const { ctx } = makeCtx("exec: ls /tmp");
    const result = await operator.execute(ctx);
    expect(result.status).toBe("success");
  });

  it("allows uptime command", async () => {
    const { ctx } = makeCtx("exec: uptime");
    const result = await operator.execute(ctx);
    expect(result.status).toBe("success");
  });
});
