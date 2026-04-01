import { describe, it, expect, afterEach } from "vitest";
import { StateStore } from "./index.js";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("StateStore persistence", () => {
  const tmpDirs: string[] = [];

  function makeTmpDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "state-test-"));
    tmpDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const d of tmpDirs) {
      rmSync(d, { recursive: true, force: true });
    }
    tmpDirs.length = 0;
  });

  it("persists checkpoints to disk as JSONL", () => {
    const path = join(makeTmpDir(), "state.jsonl");
    const store = new StateStore(path);
    store.append({ kind: "observation", event: { type: "test.a", source: "unit", timestamp: new Date().toISOString(), data: {} } });
    store.append({ kind: "goal_matched", goalId: "g1" });

    const lines = readFileSync(path, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]!);
    expect(first.seq).toBe(1);
    expect(first.kind).toBe("observation");
    const second = JSON.parse(lines[1]!);
    expect(second.seq).toBe(2);
    expect(second.kind).toBe("goal_matched");
  });

  it("restores state from existing JSONL file on construction", () => {
    const path = join(makeTmpDir(), "state.jsonl");

    // Write initial state
    const store1 = new StateStore(path);
    store1.append({ kind: "observation" });
    store1.append({ kind: "goal_matched", goalId: "g1" });

    // Create new store from same file — should restore
    const store2 = new StateStore(path);
    const all = store2.query();
    expect(all).toHaveLength(2);
    expect(all[0]?.seq).toBe(1);
    expect(all[1]?.seq).toBe(2);

    // New appends should continue sequence from where it left off
    store2.append({ kind: "goal_completed", goalId: "g1" });
    const all2 = store2.query();
    expect(all2).toHaveLength(3);
    expect(all2[2]?.seq).toBe(3);

    // And persisted to disk
    const lines = readFileSync(path, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(3);
  });

  it("works in-memory without a persist path", () => {
    const store = new StateStore();
    store.append({ kind: "observation" });
    expect(store.query()).toHaveLength(1);
  });

  it("creates directories as needed", () => {
    const path = join(makeTmpDir(), "deep", "nested", "state.jsonl");
    const store = new StateStore(path);
    store.append({ kind: "observation" });
    const content = readFileSync(path, "utf-8").trim();
    expect(content).toBeTruthy();
  });

  it("handles malformed lines gracefully", () => {
    const dir = makeTmpDir();
    const path = join(dir, "state.jsonl");
    // Write a valid line then a malformed one
    const { writeFileSync } = require("node:fs");
    writeFileSync(path, '{"seq":1,"timestamp":"t","kind":"observation"}\nnot json\n{"seq":2,"timestamp":"t","kind":"goal_matched"}\n');

    const store = new StateStore(path);
    const all = store.query();
    expect(all).toHaveLength(2); // skips malformed line
  });
});
