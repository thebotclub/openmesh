import { describe, it, expect, afterEach } from "vitest";
import { Mesh, loadGoalsFromDir } from "@openmesh/core";
import type { Operator, OperatorResult } from "@openmesh/core";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const goalsFixtureDir = resolve(__dirname, "../../../../test-fixtures/goals");

function makeRecordingOperator(id: string): { operator: Operator; calls: Array<{ task: string; result: OperatorResult }> } {
  const calls: Array<{ task: string; result: OperatorResult }> = [];
  const operator: Operator = {
    id,
    name: `${id} Operator`,
    description: `Records ${id} calls`,
    execute: async (ctx) => {
      const result: OperatorResult = { status: "success", summary: `[${id}] ${ctx.task.slice(0, 100)}` };
      calls.push({ task: ctx.task, result });
      return result;
    },
  };
  return { operator, calls };
}

describe("Multi-goal E2E", () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("loads goals from YAML directory and wires the full pipeline", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "e2e-"));
    const goalsDir = goalsFixtureDir;
    const goals = loadGoalsFromDir(goalsDir);

    expect(goals.length).toBeGreaterThanOrEqual(3);
    const ids = goals.map((g) => g.id);
    expect(ids).toContain("service-health");
    expect(ids).toContain("code-quality");
    expect(ids).toContain("incident-response");
  });

  it("cron.tick triggers service-health goal chain", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "e2e-"));
    const mesh = new Mesh({ dataDir: tmpDir, logLevel: "error" });

    const { operator: dataOp, calls: dataCalls } = makeRecordingOperator("data");
    const { operator: commsOp, calls: commsCalls } = makeRecordingOperator("comms");

    const goalsDir = goalsFixtureDir;
    const goals = loadGoalsFromDir(goalsDir);

    mesh.addOperator(dataOp).addOperator(commsOp);
    for (const g of goals) mesh.addGoal(g);

    // Inject a cron tick — should trigger service-health goal
    await mesh.inject(mesh.createEvent("cron.tick", "cron", { scheduledAt: new Date().toISOString() }));

    // Data operator should have been called for health check
    expect(dataCalls.length).toBeGreaterThanOrEqual(1);
    expect(dataCalls[0]!.task).toMatch(/stats/);

    // Comms should fire the health report
    expect(commsCalls.length).toBeGreaterThanOrEqual(1);
    expect(commsCalls[0]!.task).toMatch(/Health check/i);

    await mesh.stop();
  });

  it("github.push triggers code-quality goal chain", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "e2e-"));
    const mesh = new Mesh({ dataDir: tmpDir, logLevel: "error" });

    const { operator: codeOp, calls: codeCalls } = makeRecordingOperator("code");
    const { operator: commsOp, calls: commsCalls } = makeRecordingOperator("comms");

    const goalsDir = goalsFixtureDir;
    const goals = loadGoalsFromDir(goalsDir);

    mesh.addOperator(codeOp).addOperator(commsOp);
    for (const g of goals) mesh.addGoal(g);

    await mesh.inject(mesh.createEvent("github.push", "github-webhook", { ref: "refs/heads/main", repo: "test/repo" }));

    expect(codeCalls).toHaveLength(1);
    expect(codeCalls[0]!.task).toMatch(/TODO/);
    expect(commsCalls).toHaveLength(1);
    expect(commsCalls[0]!.task).toMatch(/Code scan complete/);

    await mesh.stop();
  });

  it("log.error triggers incident-response with chained steps", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "e2e-"));
    const mesh = new Mesh({ dataDir: tmpDir, logLevel: "error" });

    const { operator: dataOp, calls: dataCalls } = makeRecordingOperator("data");
    const { operator: codeOp, calls: codeCalls } = makeRecordingOperator("code");
    const { operator: commsOp, calls: commsCalls } = makeRecordingOperator("comms");

    const goalsDir = goalsFixtureDir;
    const goals = loadGoalsFromDir(goalsDir);

    mesh.addOperator(dataOp).addOperator(codeOp).addOperator(commsOp);
    for (const g of goals) mesh.addGoal(g);

    await mesh.inject(mesh.createEvent("log.error", "app-server", {
      message: "OOM killed",
      file: "/var/log/app.log",
      line: 42,
    }));

    // All 3 steps should fire: collect-context → analyze → notify-oncall
    expect(dataCalls).toHaveLength(1);
    expect(codeCalls).toHaveLength(1);
    expect(commsCalls).toHaveLength(1);
    expect(commsCalls[0]!.task).toMatch(/INCIDENT/);

    await mesh.stop();
  });

  it("multiple events trigger multiple goals independently", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "e2e-"));
    const mesh = new Mesh({ dataDir: tmpDir, logLevel: "error" });

    const { operator: dataOp, calls: dataCalls } = makeRecordingOperator("data");
    const { operator: codeOp, calls: codeCalls } = makeRecordingOperator("code");
    const { operator: commsOp, calls: commsCalls } = makeRecordingOperator("comms");

    const goalsDir = goalsFixtureDir;
    const goals = loadGoalsFromDir(goalsDir);

    mesh.addOperator(dataOp).addOperator(codeOp).addOperator(commsOp);
    for (const g of goals) mesh.addGoal(g);

    // Fire 3 different events
    await mesh.inject(mesh.createEvent("cron.tick", "cron", {}));
    await mesh.inject(mesh.createEvent("github.push", "github", {}));
    await mesh.inject(mesh.createEvent("log.error", "svc", {}));

    // service-health uses data+comms, code-quality uses code+comms, incident uses data+code+comms
    expect(dataCalls.length).toBe(2); // service-health + incident
    expect(codeCalls.length).toBe(2); // code-quality + incident
    expect(commsCalls.length).toBe(3); // all three goals notify

    // State should have goal completion records for all 3
    const completed = mesh.state.query({ kind: "goal_completed" });
    expect(completed.length).toBe(3);

    await mesh.stop();
  });
});
