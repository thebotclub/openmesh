import type { ObservationEvent } from "../events/index.js";
import type { OperatorResult } from "../operators/index.js";
import type { GoalState } from "../coordinators/index.js";
import { appendFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

// ── Durable State Types ─────────────────────────────────────────────

/** A checkpoint in the event-sourced log */
export interface Checkpoint {
  /** Monotonically increasing sequence number */
  seq: number;
  /** ISO-8601 timestamp */
  timestamp: string;
  /** What happened */
  kind:
    | "observation"
    | "goal_matched"
    | "step_started"
    | "step_completed"
    | "goal_completed"
    | "goal_failed"
    | "approval_requested"
    | "approval_resolved";
  /** Goal ID */
  goalId?: string;
  /** Step label */
  stepLabel?: string;
  /** The event that triggered this */
  event?: ObservationEvent;
  /** Operator result */
  result?: OperatorResult;
  /** Goal state snapshot */
  state?: GoalState;
}

/** Durable state: event-sourced execution log */
export interface DurableState {
  /** All checkpoints */
  checkpoints: Checkpoint[];
  /** Current sequence number */
  seq: number;
}

// ── State Store ─────────────────────────────────────────────────────

/**
 * Event-sourced state store. Every observation, decision, and action
 * is persisted as a checkpoint before execution.
 *
 * Supports optional disk-backed JSONL persistence.
 */
export class StateStore {
  private state: DurableState = { checkpoints: [], seq: 0 };
  private persistPath?: string;

  constructor(persistPath?: string) {
    if (persistPath) {
      this.persistPath = persistPath;
      const dir = dirname(persistPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      // Restore from existing log
      if (existsSync(persistPath)) {
        const content = readFileSync(persistPath, "utf-8").trim();
        if (content) {
          for (const line of content.split("\n")) {
            try {
              const cp = JSON.parse(line) as Checkpoint;
              this.state.checkpoints.push(cp);
              if (cp.seq > this.state.seq) this.state.seq = cp.seq;
            } catch { /* skip malformed */ }
          }
        }
      }
    }
  }

  /** Append a checkpoint to the log. Returns the sequence number. */
  append(
    checkpoint: Omit<Checkpoint, "seq" | "timestamp">,
  ): Checkpoint {
    this.state.seq++;
    const full: Checkpoint = {
      ...checkpoint,
      seq: this.state.seq,
      timestamp: new Date().toISOString(),
    };
    this.state.checkpoints.push(full);
    if (this.persistPath) {
      appendFileSync(this.persistPath, JSON.stringify(full) + "\n");
    }
    return full;
  }

  /** Get all checkpoints, optionally filtered */
  query(filter?: {
    goalId?: string;
    kind?: Checkpoint["kind"];
    since?: string;
  }): Checkpoint[] {
    let result = this.state.checkpoints;

    if (filter?.goalId) {
      result = result.filter((c) => c.goalId === filter.goalId);
    }
    if (filter?.kind) {
      result = result.filter((c) => c.kind === filter.kind);
    }
    if (filter?.since) {
      const since = filter.since;
      result = result.filter((c) => c.timestamp >= since);
    }

    return result;
  }

  /** Get the latest checkpoint for a goal */
  latest(goalId: string): Checkpoint | undefined {
    const checkpoints = this.query({ goalId });
    return checkpoints[checkpoints.length - 1];
  }

  /** Get current sequence number */
  getSeq(): number {
    return this.state.seq;
  }

  /** Full snapshot for persistence */
  snapshot(): DurableState {
    return structuredClone(this.state);
  }

  /** Restore from a snapshot */
  restore(state: DurableState): void {
    this.state = structuredClone(state);
  }
}
