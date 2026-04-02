/**
 * RAGContextBuilder — Retrieval-Augmented Generation context assembly.
 *
 * Collects recent events, checkpoints, goal states, and custom context
 * into a single Markdown-formatted string suitable for injecting into
 * LLM system prompts. Zero external dependencies — pure text processing.
 *
 * Uses a builder pattern (method chaining) so callers can pick exactly
 * which sources to include:
 *
 * @example
 * ```ts
 * const ctx = new RAGContextBuilder()
 *   .addEvents(recentEvents, { maxEvents: 10 })
 *   .addCheckpoints(checkpoints)
 *   .addGoalStates(goals)
 *   .build(8000);
 * ```
 */

import type { ObservationEvent } from "@openmesh/core";
import type { Checkpoint } from "@openmesh/core";

// ── Configuration ───────────────────────────────────────────────────

export interface RAGContextConfig {
  /** Max number of recent events to include */
  maxEvents?: number;
  /** Max number of recent checkpoints to include */
  maxCheckpoints?: number;
  /** Max characters for the total context string */
  maxContextChars?: number;
  /** Filter events by type patterns (glob-like) */
  eventTypeFilter?: string[];
}

const DEFAULT_MAX_EVENTS = 20;
const DEFAULT_MAX_CHECKPOINTS = 15;
const DEFAULT_MAX_CONTEXT_CHARS = 8000;

// ── Source Descriptor ───────────────────────────────────────────────

export interface RAGSource {
  type: "event" | "checkpoint" | "goal_state" | "custom";
  content: string;
  timestamp?: string;
  /** 0-1, used for ranking — higher relevance sources appear first */
  relevance?: number;
}

// ── Glob Matching (local, minimal) ──────────────────────────────────

function matchGlob(pattern: string, value: string): boolean {
  const regex = pattern
    .replace(/\./g, "\\.")
    .replace(/\*\*/g, "{{GLOBSTAR}}")
    .replace(/\*/g, "[^.]*")
    .replace(/\{\{GLOBSTAR\}\}/g, ".*");
  return new RegExp(`^${regex}$`).test(value);
}

// ── Builder ─────────────────────────────────────────────────────────

export class RAGContextBuilder {
  private sources: RAGSource[] = [];

  /** Add recent events from the EventBus WAL. */
  addEvents(
    events: ObservationEvent[],
    config?: Pick<RAGContextConfig, "maxEvents" | "eventTypeFilter">,
  ): this {
    const max = config?.maxEvents ?? DEFAULT_MAX_EVENTS;
    const filters = config?.eventTypeFilter;

    let filtered = events;
    if (filters?.length) {
      filtered = events.filter((e) =>
        filters.some((pattern) => matchGlob(pattern, e.type)),
      );
    }

    const recent = filtered.slice(-max);

    for (const evt of recent) {
      const payloadStr = JSON.stringify(evt.payload);
      const line = `${evt.timestamp} [${evt.type}] src=${evt.source} ${payloadStr}`;
      this.sources.push({
        type: "event",
        content: line,
        timestamp: evt.timestamp,
        relevance: 0.5,
      });
    }

    return this;
  }

  /** Add recent checkpoints from the StateStore. */
  addCheckpoints(
    checkpoints: Checkpoint[],
    config?: Pick<RAGContextConfig, "maxCheckpoints">,
  ): this {
    const max = config?.maxCheckpoints ?? DEFAULT_MAX_CHECKPOINTS;
    const recent = checkpoints.slice(-max);

    for (const cp of recent) {
      const parts = [`#${cp.seq} ${cp.timestamp} ${cp.kind}`];
      if (cp.goalId) parts.push(`goal=${cp.goalId}`);
      if (cp.stepLabel) parts.push(`step=${cp.stepLabel}`);
      if (cp.result) parts.push(`status=${cp.result.status}`);
      const line = parts.join(" ");
      this.sources.push({
        type: "checkpoint",
        content: line,
        timestamp: cp.timestamp,
        relevance: 0.6,
      });
    }

    return this;
  }

  /** Add current goal states as context. */
  addGoalStates(
    goals: Array<{ id: string; description: string; state?: unknown }>,
  ): this {
    for (const g of goals) {
      const stateStr = g.state != null ? ` state=${JSON.stringify(g.state)}` : "";
      const line = `[${g.id}] ${g.description}${stateStr}`;
      this.sources.push({
        type: "goal_state",
        content: line,
        relevance: 0.8,
      });
    }

    return this;
  }

  /** Add arbitrary text context (for extensibility). */
  addCustom(label: string, content: string, relevance?: number): this {
    this.sources.push({
      type: "custom",
      content: `[${label}] ${content}`,
      relevance: relevance ?? 0.5,
    });
    return this;
  }

  /** Build the final context string, trimmed to maxChars. */
  build(maxChars?: number): string {
    const { context } = this.buildStructured(maxChars);
    return context;
  }

  /** Build as a structured object for programmatic use. */
  buildStructured(maxChars?: number): {
    context: string;
    sources: RAGSource[];
    truncated: boolean;
  } {
    const limit = maxChars ?? DEFAULT_MAX_CONTEXT_CHARS;

    // Sort by relevance (descending), then by timestamp (newest first)
    const sorted = [...this.sources].sort((a, b) => {
      const relDiff = (b.relevance ?? 0) - (a.relevance ?? 0);
      if (relDiff !== 0) return relDiff;
      if (a.timestamp && b.timestamp) return b.timestamp.localeCompare(a.timestamp);
      return 0;
    });

    // Group by type for section headers
    const sections = new Map<RAGSource["type"], RAGSource[]>();
    for (const s of sorted) {
      const list = sections.get(s.type) ?? [];
      list.push(s);
      sections.set(s.type, list);
    }

    const sectionOrder: Array<{ key: RAGSource["type"]; heading: string }> = [
      { key: "goal_state", heading: "## Active Goals" },
      { key: "checkpoint", heading: "## Execution History" },
      { key: "event", heading: "## Recent Events" },
      { key: "custom", heading: "## Additional Context" },
    ];

    const parts: string[] = [];
    for (const { key, heading } of sectionOrder) {
      const items = sections.get(key);
      if (!items?.length) continue;
      parts.push(heading);
      for (const item of items) {
        parts.push(`- ${item.content}`);
      }
    }

    const full = parts.join("\n");
    const truncated = full.length > limit;
    const context = truncated ? full.slice(0, limit) : full;

    return { context, sources: sorted, truncated };
  }
}

// ── Convenience Function ────────────────────────────────────────────

/**
 * Build context directly from a Mesh's state + events.
 * Shorthand for constructing a RAGContextBuilder, adding all sources,
 * and calling build().
 */
export function buildMeshContext(
  events: ObservationEvent[],
  checkpoints: Checkpoint[],
  goals: Array<{ id: string; description: string; state?: unknown }>,
  config?: RAGContextConfig,
): string {
  return new RAGContextBuilder()
    .addEvents(events, {
      maxEvents: config?.maxEvents,
      eventTypeFilter: config?.eventTypeFilter,
    })
    .addCheckpoints(checkpoints, {
      maxCheckpoints: config?.maxCheckpoints,
    })
    .addGoalStates(goals)
    .build(config?.maxContextChars);
}
