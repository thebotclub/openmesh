import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AuditLog, type AuditConfig } from "../audit.js";

// ── Helpers ─────────────────────────────────────────────────────────

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "openmesh-audit-"));
}

function makeLog(dir: string, overrides?: Partial<AuditConfig>): AuditLog {
  return new AuditLog({
    enabled: true,
    filePath: join(dir, "audit.log.jsonl"),
    flushThreshold: 1000, // high threshold to control flush manually
    ...overrides,
  });
}

function addEntries(log: AuditLog, count: number, base?: Partial<{ principalId: string; action: string; resource: string; allowed: boolean }>) {
  for (let i = 0; i < count; i++) {
    log.log({
      principalId: base?.principalId ?? "user-1",
      action: base?.action ?? "operator.execute",
      resource: base?.resource ?? "operator:code",
      allowed: base?.allowed ?? true,
      result: "success",
    });
  }
}

// ── Tests ───────────────────────────────────────────────────────────

describe("AuditLog", () => {
  let dir: string;

  beforeEach(() => {
    dir = tmpDir();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe("logging and querying", () => {
    it("logs entries with auto-generated id and timestamp", () => {
      const log = makeLog(dir);
      const entry = log.log({
        principalId: "alice",
        action: "operator.execute",
        resource: "operator:code",
        allowed: true,
        result: "success",
      });

      expect(entry.id).toBeTruthy();
      expect(entry.timestamp).toBeTruthy();
      expect(entry.principalId).toBe("alice");
    });

    it("queries all entries when no filter provided", () => {
      const log = makeLog(dir);
      addEntries(log, 5);
      expect(log.query().length).toBe(5);
    });

    it("queries by principalId", () => {
      const log = makeLog(dir);
      addEntries(log, 3, { principalId: "alice" });
      addEntries(log, 2, { principalId: "bob" });

      expect(log.query({ principalId: "alice" }).length).toBe(3);
      expect(log.query({ principalId: "bob" }).length).toBe(2);
    });

    it("queries by action", () => {
      const log = makeLog(dir);
      log.log({ principalId: "x", action: "operator.execute", resource: "r", allowed: true });
      log.log({ principalId: "x", action: "event.inject", resource: "r", allowed: true });
      log.log({ principalId: "x", action: "operator.execute", resource: "r", allowed: true });

      expect(log.query({ action: "operator.execute" }).length).toBe(2);
      expect(log.query({ action: "event.inject" }).length).toBe(1);
    });

    it("queries by resource", () => {
      const log = makeLog(dir);
      log.log({ principalId: "x", action: "a", resource: "operator:code", allowed: true });
      log.log({ principalId: "x", action: "a", resource: "operator:infra", allowed: true });

      expect(log.query({ resource: "operator:code" }).length).toBe(1);
    });

    it("queries by allowed flag", () => {
      const log = makeLog(dir);
      log.log({ principalId: "x", action: "a", resource: "r", allowed: true });
      log.log({ principalId: "x", action: "a", resource: "r", allowed: false });
      log.log({ principalId: "x", action: "a", resource: "r", allowed: true });

      expect(log.query({ allowed: true }).length).toBe(2);
      expect(log.query({ allowed: false }).length).toBe(1);
    });

    it("queries with since/until date range", () => {
      const log = makeLog(dir);

      // Log entries at different logical times
      const e1 = log.log({ principalId: "x", action: "a", resource: "r", allowed: true });
      const e2 = log.log({ principalId: "x", action: "a", resource: "r", allowed: true });
      const e3 = log.log({ principalId: "x", action: "a", resource: "r", allowed: true });

      // Query using the timestamp of the second entry
      const since = e2.timestamp;
      expect(log.query({ since }).length).toBeGreaterThanOrEqual(2);

      const until = e1.timestamp;
      expect(log.query({ until }).length).toBeGreaterThanOrEqual(1);
    });

    it("queries with limit", () => {
      const log = makeLog(dir);
      addEntries(log, 10);

      expect(log.query({ limit: 3 }).length).toBe(3);
    });

    it("combines multiple filters", () => {
      const log = makeLog(dir);
      log.log({ principalId: "alice", action: "operator.execute", resource: "operator:code", allowed: true });
      log.log({ principalId: "alice", action: "event.inject", resource: "event:tick", allowed: true });
      log.log({ principalId: "bob", action: "operator.execute", resource: "operator:code", allowed: false });

      const results = log.query({ principalId: "alice", action: "operator.execute" });
      expect(results.length).toBe(1);
      expect(results[0]!.resource).toBe("operator:code");
    });
  });

  describe("recent entries", () => {
    it("returns the last N entries", () => {
      const log = makeLog(dir);
      addEntries(log, 20);

      const recent = log.recent(5);
      expect(recent.length).toBe(5);
    });

    it("defaults to 10", () => {
      const log = makeLog(dir);
      addEntries(log, 15);

      expect(log.recent().length).toBe(10);
    });

    it("returns all if fewer than requested", () => {
      const log = makeLog(dir);
      addEntries(log, 3);

      expect(log.recent(10).length).toBe(3);
    });
  });

  describe("flush to disk", () => {
    it("writes entries to JSONL file", () => {
      const log = makeLog(dir);
      addEntries(log, 3);
      log.flush();

      const filePath = join(dir, "audit.log.jsonl");
      expect(existsSync(filePath)).toBe(true);

      const lines = readFileSync(filePath, "utf-8").trim().split("\n");
      expect(lines.length).toBe(3);

      const parsed = JSON.parse(lines[0]!);
      expect(parsed.principalId).toBe("user-1");
      expect(parsed.id).toBeTruthy();
    });

    it("appends on subsequent flushes", () => {
      const log = makeLog(dir);
      addEntries(log, 2);
      log.flush();
      addEntries(log, 3);
      log.flush();

      const filePath = join(dir, "audit.log.jsonl");
      const lines = readFileSync(filePath, "utf-8").trim().split("\n");
      expect(lines.length).toBe(5);
    });

    it("creates directory if it doesn't exist", () => {
      const nested = join(dir, "sub", "dir");
      const log = new AuditLog({
        enabled: true,
        filePath: join(nested, "audit.log.jsonl"),
        flushThreshold: 1000,
      });
      log.log({ principalId: "x", action: "a", resource: "r", allowed: true });
      log.flush();

      expect(existsSync(join(nested, "audit.log.jsonl"))).toBe(true);
    });

    it("auto-flushes when threshold is reached", () => {
      const log = new AuditLog({
        enabled: true,
        filePath: join(dir, "audit.log.jsonl"),
        flushThreshold: 3,
      });

      log.log({ principalId: "x", action: "a", resource: "r", allowed: true });
      log.log({ principalId: "x", action: "a", resource: "r", allowed: true });
      // Not flushed yet
      expect(existsSync(join(dir, "audit.log.jsonl"))).toBe(false);

      log.log({ principalId: "x", action: "a", resource: "r", allowed: true });
      // Now auto-flushed
      expect(existsSync(join(dir, "audit.log.jsonl"))).toBe(true);
    });
  });

  describe("restore from disk", () => {
    it("restores entries from JSONL file", () => {
      const filePath = join(dir, "audit.log.jsonl");

      // Write some entries
      const log1 = makeLog(dir);
      addEntries(log1, 5);
      log1.flush();

      // Create new instance and restore
      const log2 = makeLog(dir);
      log2.restore();
      expect(log2.query().length).toBe(5);
    });

    it("handles missing file gracefully", () => {
      const log = makeLog(dir);
      log.restore();
      expect(log.query().length).toBe(0);
    });

    it("skips malformed lines", () => {
      const filePath = join(dir, "audit.log.jsonl");
      const now = new Date().toISOString();
      writeFileSync(
        filePath,
        `{"id":"1","timestamp":"${now}","principalId":"x","action":"a","resource":"r","allowed":true}\nBAD LINE\n{"id":"2","timestamp":"${now}","principalId":"y","action":"b","resource":"s","allowed":false}\n`,
        "utf-8",
      );

      const log = makeLog(dir);
      log.restore();
      expect(log.query().length).toBe(2);
    });

    it("applies retention filter on restore", () => {
      const filePath = join(dir, "audit.log.jsonl");

      const old = new Date(Date.now() - 60 * 86_400_000).toISOString(); // 60 days ago
      const recent = new Date().toISOString();

      writeFileSync(
        filePath,
        `{"id":"1","timestamp":"${old}","principalId":"x","action":"a","resource":"r","allowed":true}\n{"id":"2","timestamp":"${recent}","principalId":"y","action":"b","resource":"s","allowed":true}\n`,
        "utf-8",
      );

      const log = new AuditLog({
        enabled: true,
        filePath,
        retentionDays: 30,
        flushThreshold: 1000,
      });
      log.restore();
      expect(log.query().length).toBe(1);
      expect(log.query()[0]!.principalId).toBe("y");
    });
  });

  describe("rotation", () => {
    it("rotates when maxEntries exceeded on flush", () => {
      const log = new AuditLog({
        enabled: true,
        filePath: join(dir, "audit.log.jsonl"),
        maxEntries: 5,
        flushThreshold: 1000,
      });

      addEntries(log, 10);
      log.flush();

      // Should have rotated: original file renamed, new file created
      const files = readdirSync(dir).filter((f) => f.includes("audit.log"));
      expect(files.length).toBe(2); // rotated + current
      expect(files.some((f) => f === "audit.log.jsonl")).toBe(true);
    });
  });

  describe("disabled", () => {
    it("returns stub entry when disabled", () => {
      const log = new AuditLog({ enabled: false });
      const entry = log.log({
        principalId: "x",
        action: "a",
        resource: "r",
        allowed: true,
      });
      expect(entry.id).toBe("");
      expect(log.size).toBe(0);
    });
  });

  describe("size property", () => {
    it("tracks in-memory entry count", () => {
      const log = makeLog(dir);
      expect(log.size).toBe(0);
      addEntries(log, 7);
      expect(log.size).toBe(7);
    });
  });
});
