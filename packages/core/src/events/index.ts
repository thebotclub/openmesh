import { z } from "zod";
import { appendFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

// ── Event Types ─────────────────────────────────────────────────────

export const ObservationEventSchema = z.object({
  id: z.string(),
  type: z.string(),
  timestamp: z.string().datetime(),
  source: z.string(),
  payload: z.record(z.unknown()),
  dedupKey: z.string().optional(),
});

export type ObservationEvent<
  T extends Record<string, unknown> = Record<string, unknown>,
> = Omit<z.infer<typeof ObservationEventSchema>, "payload"> & { payload: T };

// ── Event Pattern Matching ──────────────────────────────────────────

export interface EventPattern {
  type: string;
  where?: Record<string, unknown>;
}

export type EventHandler = (event: ObservationEvent) => void | Promise<void>;

// ── Write-Ahead Log ─────────────────────────────────────────────────

export interface WAL {
  append(event: ObservationEvent): void;
  replay(): ObservationEvent[];
}

/** File-based WAL: append-only JSONL persistence */
export class FileWAL implements WAL {
  constructor(private path: string) {
    const dir = dirname(path);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  append(event: ObservationEvent): void {
    appendFileSync(this.path, JSON.stringify(event) + "\n");
  }

  replay(): ObservationEvent[] {
    if (!existsSync(this.path)) return [];
    const content = readFileSync(this.path, "utf-8").trim();
    if (!content) return [];
    return content.split("\n").map((line) => JSON.parse(line) as ObservationEvent);
  }
}

/** In-memory WAL for testing */
export class MemoryWAL implements WAL {
  private log: ObservationEvent[] = [];

  append(event: ObservationEvent): void {
    this.log.push(event);
  }

  replay(): ObservationEvent[] {
    return [...this.log];
  }
}

// ── Event Bus ───────────────────────────────────────────────────────

export class EventBus {
  private handlers = new Map<string, Set<EventHandler>>();
  private wal: WAL;

  constructor(wal?: WAL) {
    this.wal = wal ?? new MemoryWAL();
  }

  on(pattern: string, handler: EventHandler): () => void {
    let set = this.handlers.get(pattern);
    if (!set) {
      set = new Set();
      this.handlers.set(pattern, set);
    }
    set.add(handler);
    return () => {
      set!.delete(handler);
    };
  }

  async emit(event: ObservationEvent): Promise<void> {
    this.wal.append(event);

    const promises: Promise<void>[] = [];
    for (const [pattern, handlers] of this.handlers) {
      if (matchGlob(pattern, event.type)) {
        for (const handler of handlers) {
          promises.push(
            (async () => {
              try {
                await handler(event);
              } catch (err) {
                console.error(`[EventBus] handler error for ${event.type}:`, err);
              }
            })(),
          );
        }
      }
    }
    await Promise.all(promises);
  }

  getLog(): ObservationEvent[] {
    return this.wal.replay();
  }

  clear(): void {
    this.handlers.clear();
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

export function matchGlob(pattern: string, value: string): boolean {
  const regex = pattern
    .replace(/\./g, "\\.")
    .replace(/\*\*/g, "{{GLOBSTAR}}")
    .replace(/\*/g, "[^.]*")
    .replace(/\{\{GLOBSTAR\}\}/g, ".*");
  return new RegExp(`^${regex}$`).test(value);
}
