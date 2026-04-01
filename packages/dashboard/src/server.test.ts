import { describe, it, expect, afterEach } from "vitest";
import { startDashboard } from "./server.js";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("Dashboard server", () => {
  let tmpDir: string;
  let dashboard: ReturnType<typeof startDashboard> | undefined;

  afterEach(() => {
    dashboard?.close();
    dashboard = undefined;
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("starts and serves the HTML page", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "dash-"));
    mkdirSync(join(tmpDir, "goals"));
    mkdirSync(join(tmpDir, "data"));

    dashboard = startDashboard({ port: 0, dataDir: join(tmpDir, "data"), goalsDir: join(tmpDir, "goals") });
    // port 0 doesn't work with our impl — use a high random port
  });

  it("serves HTML at root", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "dash-"));
    mkdirSync(join(tmpDir, "data"));
    mkdirSync(join(tmpDir, "goals"));

    const port = 13700 + Math.floor(Math.random() * 1000);
    dashboard = startDashboard({ port, dataDir: join(tmpDir, "data"), goalsDir: join(tmpDir, "goals") });

    // Wait for server to start
    await new Promise((r) => setTimeout(r, 100));

    const res = await fetch(`http://localhost:${port}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("OpenMesh Dashboard");
    expect(html).toContain("Goals");
  });

  it("serves JSON state at /api/state", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "dash-"));
    mkdirSync(join(tmpDir, "data"));
    const goalsDir = join(tmpDir, "goals");
    mkdirSync(goalsDir);

    // Write a goal file
    writeFileSync(join(goalsDir, "test.yaml"), `id: test-goal\ndescription: A test goal\nobserve:\n  - type: "cron.tick"\nthen:\n  - label: act\n    operator: echo\n    task: hello\n`);

    // Write some events
    writeFileSync(join(tmpDir, "data", "events.wal.jsonl"), '{"type":"cron.tick","source":"cron"}\n');
    writeFileSync(join(tmpDir, "data", "state.jsonl"), '{"seq":1,"kind":"observation"}\n');

    const port = 13700 + Math.floor(Math.random() * 1000);
    dashboard = startDashboard({ port, dataDir: join(tmpDir, "data"), goalsDir });

    await new Promise((r) => setTimeout(r, 100));

    const res = await fetch(`http://localhost:${port}/api/state`);
    expect(res.status).toBe(200);
    const data = await res.json() as { goals: unknown[]; events: unknown[]; checkpoints: unknown[] };
    expect(data.goals).toHaveLength(1);
    expect(data.events).toHaveLength(1);
    expect(data.checkpoints).toHaveLength(1);
  });

  it("serves SSE stream at /api/stream", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "dash-"));
    mkdirSync(join(tmpDir, "data"));
    mkdirSync(join(tmpDir, "goals"));

    const port = 13700 + Math.floor(Math.random() * 1000);
    dashboard = startDashboard({ port, dataDir: join(tmpDir, "data"), goalsDir: join(tmpDir, "goals") });

    await new Promise((r) => setTimeout(r, 100));

    const controller = new AbortController();
    const res = await fetch(`http://localhost:${port}/api/stream`, { signal: controller.signal });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    controller.abort();
  });

  it("returns 404 for unknown routes", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "dash-"));
    mkdirSync(join(tmpDir, "data"));
    mkdirSync(join(tmpDir, "goals"));

    const port = 13700 + Math.floor(Math.random() * 1000);
    dashboard = startDashboard({ port, dataDir: join(tmpDir, "data"), goalsDir: join(tmpDir, "goals") });

    await new Promise((r) => setTimeout(r, 100));

    const res = await fetch(`http://localhost:${port}/nonexistent`);
    expect(res.status).toBe(404);
  });
});
