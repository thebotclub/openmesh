import { describe, it, expect, afterEach } from "vitest";
import { EventBus, MemoryWAL, FileWAL, matchGlob, type ObservationEvent } from "./index.js";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function makeEvent(overrides: Partial<ObservationEvent> = {}): ObservationEvent {
  return {
    id: "evt-1",
    type: "test.event",
    timestamp: new Date().toISOString(),
    source: "test",
    payload: {},
    ...overrides,
  };
}

describe("matchGlob", () => {
  it("matches exact type", () => {
    expect(matchGlob("cron.tick", "cron.tick")).toBe(true);
    expect(matchGlob("cron.tick", "cron.tock")).toBe(false);
  });

  it("matches single-level wildcard", () => {
    expect(matchGlob("cron.*", "cron.tick")).toBe(true);
    expect(matchGlob("cron.*", "cron.tick.deep")).toBe(false);
  });

  it("matches double-level wildcard", () => {
    expect(matchGlob("ci.**", "ci.build.failed")).toBe(true);
    expect(matchGlob("**", "any.event.type")).toBe(true);
  });
});

describe("MemoryWAL", () => {
  it("appends and replays events", () => {
    const wal = new MemoryWAL();
    const e1 = makeEvent({ id: "a" });
    const e2 = makeEvent({ id: "b" });
    wal.append(e1);
    wal.append(e2);
    expect(wal.replay()).toEqual([e1, e2]);
  });

  it("returns copy on replay (no mutation)", () => {
    const wal = new MemoryWAL();
    wal.append(makeEvent());
    const r1 = wal.replay();
    const r2 = wal.replay();
    expect(r1).not.toBe(r2);
    expect(r1).toEqual(r2);
  });
});

describe("FileWAL", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir && existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true });
    }
  });

  it("persists events to disk and replays them", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "openmesh-test-"));
    const walPath = join(tmpDir, "events.wal.jsonl");
    const wal = new FileWAL(walPath);
    const e1 = makeEvent({ id: "a" });
    const e2 = makeEvent({ id: "b" });
    wal.append(e1);
    wal.append(e2);

    // Read from a fresh instance to prove disk persistence
    const wal2 = new FileWAL(walPath);
    const replayed = wal2.replay();
    expect(replayed).toHaveLength(2);
    expect(replayed[0]!.id).toBe("a");
    expect(replayed[1]!.id).toBe("b");
  });

  it("returns empty array for non-existent file", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "openmesh-test-"));
    const wal = new FileWAL(join(tmpDir, "nope.jsonl"));
    expect(wal.replay()).toEqual([]);
  });
});

describe("EventBus", () => {
  it("delivers events to matching handlers", async () => {
    const bus = new EventBus(new MemoryWAL());
    const received: ObservationEvent[] = [];
    bus.on("test.*", (e) => { received.push(e); });

    await bus.emit(makeEvent({ type: "test.hello" }));
    await bus.emit(makeEvent({ type: "other.skip" }));

    expect(received).toHaveLength(1);
    expect(received[0]!.type).toBe("test.hello");
  });

  it("supports wildcard ** handler", async () => {
    const bus = new EventBus(new MemoryWAL());
    const received: ObservationEvent[] = [];
    bus.on("**", (e) => { received.push(e); });

    await bus.emit(makeEvent({ type: "any.deep.event" }));
    expect(received).toHaveLength(1);
  });

  it("persists events to WAL", async () => {
    const wal = new MemoryWAL();
    const bus = new EventBus(wal);
    await bus.emit(makeEvent({ id: "x" }));
    expect(bus.getLog()).toHaveLength(1);
    expect(bus.getLog()[0]!.id).toBe("x");
  });

  it("unsubscribe function removes handler", async () => {
    const bus = new EventBus(new MemoryWAL());
    const received: string[] = [];
    const unsub = bus.on("test.*", (e) => { received.push(e.id); });

    await bus.emit(makeEvent({ id: "1", type: "test.a" }));
    unsub();
    await bus.emit(makeEvent({ id: "2", type: "test.b" }));

    expect(received).toEqual(["1"]);
  });

  it("handler errors don't crash the bus", async () => {
    const bus = new EventBus(new MemoryWAL());
    const received: string[] = [];
    bus.on("test.*", () => { throw new Error("boom"); });
    bus.on("test.*", (e) => { received.push(e.id); });

    await bus.emit(makeEvent({ id: "ok", type: "test.a" }));
    expect(received).toEqual(["ok"]);
  });
});
