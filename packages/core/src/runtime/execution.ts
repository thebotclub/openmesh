import type { ObservationEvent } from "../events/index.js";
import type { OperatorResult } from "../operators/index.js";

export type ExecutionEventType =
  | 'goal:matched'
  | 'step:started'
  | 'step:skipped'
  | 'step:completed'
  | 'goal:completed'
  | 'goal:failed';

export interface ExecutionEvent {
  type: ExecutionEventType;
  timestamp: string;
  goalId: string;
  event?: ObservationEvent;
  stepLabel?: string;
  stepIndex?: number;
  totalSteps?: number;
  result?: OperatorResult;
  reason?: string;
}

export type ExecutionListener = (event: ExecutionEvent) => void;

/**
 * Manages execution listeners so external consumers (Dashboard SSE,
 * telemetry, CLI) can subscribe to real-time goal execution progress.
 */
export class ExecutionEmitter {
  private listeners = new Set<ExecutionListener>();

  /** Subscribe to execution events */
  on(listener: ExecutionListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Emit an execution event to all listeners */
  emit(event: ExecutionEvent): void {
    for (const listener of this.listeners) {
      try { listener(event); } catch { /* listener errors don't crash execution */ }
    }
  }

  /** Number of active listeners */
  get size(): number {
    return this.listeners.size;
  }
}
