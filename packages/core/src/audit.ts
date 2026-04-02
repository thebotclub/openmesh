/**
 * @openmesh/core — Audit log for tracking all mesh operations.
 *
 * Buffers entries in memory, flushes to JSONL files, supports
 * querying, rotation, and retention.
 */

import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

// ── Types ───────────────────────────────────────────────────────────

export interface AuditEntry {
  id: string;
  timestamp: string;
  principalId: string;
  action: string;
  resource: string;
  allowed: boolean;
  details?: Record<string, unknown>;
  duration?: number;
  result?: "success" | "failure" | "denied";
}

export interface AuditConfig {
  /** When false, logging is disabled. Default: true */
  enabled?: boolean;
  /** JSONL file path. Default: ".openmesh/audit.log.jsonl" */
  filePath?: string;
  /** Max entries before rotation. Default: 10000 */
  maxEntries?: number;
  /** Auto-delete entries older than this many days. Default: 30 */
  retentionDays?: number;
  /** Flush to disk after this many buffered entries. Default: 50 */
  flushThreshold?: number;
}

export interface AuditQueryFilter {
  principalId?: string;
  action?: string;
  resource?: string;
  allowed?: boolean;
  since?: string;
  until?: string;
  limit?: number;
}

// ── AuditLog ────────────────────────────────────────────────────────

export class AuditLog {
  private entries: AuditEntry[] = [];
  private _enabled: boolean;
  private filePath: string;
  private maxEntries: number;
  private retentionDays: number;
  private flushThreshold: number;
  private bufferedSinceFlush = 0;

  constructor(config?: AuditConfig) {
    this._enabled = config?.enabled ?? true;
    this.filePath = config?.filePath ?? ".openmesh/audit.log.jsonl";
    this.maxEntries = config?.maxEntries ?? 10_000;
    this.retentionDays = config?.retentionDays ?? 30;
    this.flushThreshold = config?.flushThreshold ?? 50;
  }

  get enabled(): boolean {
    return this._enabled;
  }

  /** Log an audit entry. Auto-generates id and timestamp. */
  log(entry: Omit<AuditEntry, "id" | "timestamp">): AuditEntry {
    if (!this._enabled) return { id: "", timestamp: "", ...entry };

    const full: AuditEntry = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      ...entry,
    };

    this.entries.push(full);
    this.bufferedSinceFlush++;

    // Auto-flush if threshold reached
    if (this.bufferedSinceFlush >= this.flushThreshold) {
      this.flush();
    }

    return full;
  }

  /** Query entries matching all provided filters */
  query(filter?: AuditQueryFilter): AuditEntry[] {
    let results = this.entries;

    if (!filter) return [...results];

    if (filter.principalId !== undefined) {
      results = results.filter((e) => e.principalId === filter.principalId);
    }
    if (filter.action !== undefined) {
      results = results.filter((e) => e.action === filter.action);
    }
    if (filter.resource !== undefined) {
      results = results.filter((e) => e.resource === filter.resource);
    }
    if (filter.allowed !== undefined) {
      results = results.filter((e) => e.allowed === filter.allowed);
    }
    if (filter.since !== undefined) {
      const since = filter.since;
      results = results.filter((e) => e.timestamp >= since);
    }
    if (filter.until !== undefined) {
      const until = filter.until;
      results = results.filter((e) => e.timestamp <= until);
    }
    if (filter.limit !== undefined && filter.limit > 0) {
      results = results.slice(-filter.limit);
    }

    return [...results];
  }

  /** Get the N most recent entries */
  recent(count = 10): AuditEntry[] {
    return this.entries.slice(-count);
  }

  /** Total number of entries in memory */
  get size(): number {
    return this.entries.length;
  }

  /** Flush buffered entries to the JSONL file */
  flush(): void {
    if (!this._enabled || this.bufferedSinceFlush === 0) return;

    const dir = dirname(this.filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    // Write only the new entries since last flush
    const newEntries = this.entries.slice(-this.bufferedSinceFlush);
    const lines = newEntries.map((e) => JSON.stringify(e)).join("\n") + "\n";
    appendFileSync(this.filePath, lines, "utf-8");
    this.bufferedSinceFlush = 0;

    // Rotate if total on-disk entries exceed maxEntries
    this.rotateIfNeeded();
  }

  /** Restore entries from the JSONL file on disk */
  restore(): void {
    if (!existsSync(this.filePath)) return;

    const content = readFileSync(this.filePath, "utf-8").trim();
    if (!content) return;

    const cutoff = this.retentionDays > 0
      ? new Date(Date.now() - this.retentionDays * 86_400_000).toISOString()
      : undefined;

    const restored: AuditEntry[] = [];
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as AuditEntry;
        // Apply retention filter
        if (cutoff && entry.timestamp < cutoff) continue;
        restored.push(entry);
      } catch {
        // Skip malformed lines
      }
    }

    this.entries = restored;
    this.bufferedSinceFlush = 0;
  }

  // ── Internal ────────────────────────────────────────────────────

  private rotateIfNeeded(): void {
    if (!existsSync(this.filePath)) return;

    const content = readFileSync(this.filePath, "utf-8").trim();
    const lineCount = content ? content.split("\n").length : 0;

    if (lineCount > this.maxEntries) {
      const rotatedPath = this.filePath.replace(
        /\.jsonl$/,
        `.${Date.now()}.jsonl`,
      );
      renameSync(this.filePath, rotatedPath);
      // Write current in-memory entries back to fresh file
      const lines = this.entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
      writeFileSync(this.filePath, lines, "utf-8");
    }
  }
}
