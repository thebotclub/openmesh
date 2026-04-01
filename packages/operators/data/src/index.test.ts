import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import operator from "./index.js";

function makeCtx(task: string) {
  const logs: string[] = [];
  return {
    ctx: {
      task,
      event: { type: "test", source: "test", timestamp: new Date().toISOString(), data: {} },
      previousSteps: {},
      signal: new AbortController().signal,
      log: (msg: string) => logs.push(msg),
      requestApproval: async () => true,
    },
    logs,
  };
}

describe("Data Operator", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "data-op-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reads a file and returns its content", async () => {
    const file = join(tmpDir, "hello.txt");
    writeFileSync(file, "Hello, World!");
    const { ctx } = makeCtx(`read: ${file}`);
    const result = await operator.execute(ctx);
    expect(result.status).toBe("success");
    expect(result.data?.content).toBe("Hello, World!");
    expect(result.data?.size).toBe(13);
  });

  it("returns failure for missing file", async () => {
    const { ctx } = makeCtx(`read: ${join(tmpDir, "missing.txt")}`);
    const result = await operator.execute(ctx);
    expect(result.status).toBe("failure");
    expect(result.summary).toMatch(/not found/i);
  });

  it("counts files in a directory", async () => {
    writeFileSync(join(tmpDir, "a.ts"), "");
    writeFileSync(join(tmpDir, "b.ts"), "");
    writeFileSync(join(tmpDir, "c.json"), "");
    const { ctx } = makeCtx(`count: ${tmpDir}`);
    const result = await operator.execute(ctx);
    expect(result.status).toBe("success");
    expect(result.data?.count).toBe(3);
  });

  it("counts files filtered by extension", async () => {
    writeFileSync(join(tmpDir, "a.ts"), "");
    writeFileSync(join(tmpDir, "b.ts"), "");
    writeFileSync(join(tmpDir, "c.json"), "");
    const { ctx } = makeCtx(`count: ${tmpDir} .ts`);
    const result = await operator.execute(ctx);
    expect(result.status).toBe("success");
    expect(result.data?.count).toBe(2);
  });

  it("greps for a pattern in a file", async () => {
    const file = join(tmpDir, "log.txt");
    writeFileSync(file, "line one\nERROR: something broke\nline three\nERROR: again\n");
    const { ctx } = makeCtx(`grep: ERROR in ${file}`);
    const result = await operator.execute(ctx);
    expect(result.status).toBe("success");
    expect(result.data?.matchCount).toBe(2);
    expect(result.data?.matches).toHaveLength(2);
  });

  it("returns stats for a directory", async () => {
    writeFileSync(join(tmpDir, "a.txt"), "hello");
    mkdirSync(join(tmpDir, "sub"));
    writeFileSync(join(tmpDir, "sub", "b.txt"), "world");
    const { ctx } = makeCtx(`stats: ${tmpDir}`);
    const result = await operator.execute(ctx);
    expect(result.status).toBe("success");
    expect(result.data?.fileCount).toBe(1); // top-level only
    expect(result.data?.dirCount).toBe(1);
  });

  it("shows available commands on unknown task", async () => {
    const { ctx } = makeCtx("do something");
    const result = await operator.execute(ctx);
    expect(result.status).toBe("success");
    expect(result.summary).toMatch(/read|count|grep|stats/i);
  });
});
