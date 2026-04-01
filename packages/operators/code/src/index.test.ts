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

describe("Code Operator", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "code-op-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("analyzes a TypeScript file's structure", async () => {
    const file = join(tmpDir, "example.ts");
    writeFileSync(
      file,
      `import { foo } from "bar";
export function hello() {}
export const greet = (name: string) => name;
const internal = 42;
`,
    );
    const { ctx } = makeCtx(`analyze: ${file}`);
    const result = await operator.execute(ctx);
    expect(result.status).toBe("success");
    expect(result.data?.lineCount).toBe(5);
    expect(result.data?.importCount).toBe(1);
    expect(result.data?.exportCount).toBe(2);
    expect(result.data?.functionCount).toBe(2); // function hello + const greet = () =>
  });

  it("returns failure when analyzing a missing file", async () => {
    const { ctx } = makeCtx(`analyze: ${join(tmpDir, "nope.ts")}`);
    const result = await operator.execute(ctx);
    expect(result.status).toBe("failure");
    expect(result.summary).toMatch(/not found/i);
  });

  it("searches files for a pattern in a directory", async () => {
    mkdirSync(join(tmpDir, "src"));
    writeFileSync(join(tmpDir, "src", "a.ts"), "const x = 1;\nconst TODO = 'fix me';\n");
    writeFileSync(join(tmpDir, "src", "b.ts"), "// nothing here\n");
    writeFileSync(join(tmpDir, "src", "c.ts"), "TODO: another one\n");
    const { ctx } = makeCtx(`search: TODO in ${join(tmpDir, "src")}`);
    const result = await operator.execute(ctx);
    expect(result.status).toBe("success");
    expect(result.data?.matchCount).toBe(2);
  });

  it("returns failure for search in missing directory", async () => {
    const { ctx } = makeCtx(`search: foo in ${join(tmpDir, "nonexistent")}`);
    const result = await operator.execute(ctx);
    expect(result.status).toBe("failure");
  });

  it("runs a test command and reports success", async () => {
    const { ctx } = makeCtx("test: echo all tests passed");
    const result = await operator.execute(ctx);
    expect(result.status).toBe("success");
    expect(result.data?.passed).toBe(true);
    expect(result.data?.output).toContain("all tests passed");
  });

  it("reports test command failure", async () => {
    const { ctx } = makeCtx("test: false");
    const result = await operator.execute(ctx);
    expect(result.status).toBe("failure");
    expect(result.data?.passed).toBe(false);
  });

  it("returns available commands on unknown task", async () => {
    const { ctx } = makeCtx("investigate production bug");
    const result = await operator.execute(ctx);
    expect(result.status).toBe("success");
    expect(result.data?.availableCommands).toContain("analyze");
    expect(result.data?.availableCommands).toContain("search");
  });
});
