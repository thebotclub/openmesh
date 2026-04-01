// ── Operator Types ───────────────────────────────────────────────────

/** Result of an operator execution */
export interface OperatorResult {
  status: "success" | "failure" | "timeout" | "denied";
  summary: string;
  /** Structured output for downstream coordinators */
  data?: Record<string, unknown>;
  /** Duration in milliseconds */
  durationMs?: number;
}

/** Context passed to operator execute functions */
export interface OperatorContext {
  /** The task description from the coordinator */
  task: string;
  /** Event that triggered this execution */
  event: Record<string, unknown>;
  /** Signal for timeout / cancellation */
  signal: AbortSignal;
  /** Operator-scoped logger */
  log: (message: string, ...args: unknown[]) => void;
  /** Request human approval (blocks until approved/denied) */
  requestApproval: (description: string) => Promise<boolean>;
}

/** Operator definition — a specialized action executor */
export interface Operator {
  /** Unique operator ID */
  id: string;
  /** Human-readable name */
  name: string;
  /** What this operator does */
  description: string;
  /** Execute a task and return a result */
  execute: (ctx: OperatorContext) => Promise<OperatorResult>;
  /** Optional cleanup */
  dispose?: () => Promise<void>;
}

// ── Operator Registry ───────────────────────────────────────────────

export class OperatorRegistry {
  private operators = new Map<string, Operator>();

  register(operator: Operator): void {
    if (this.operators.has(operator.id)) {
      throw new Error(`Operator already registered: ${operator.id}`);
    }
    this.operators.set(operator.id, operator);
  }

  /** Execute an operator by ID with the given context */
  async execute(
    operatorId: string,
    ctx: OperatorContext,
  ): Promise<OperatorResult> {
    const operator = this.operators.get(operatorId);
    if (!operator) {
      return {
        status: "failure",
        summary: `Unknown operator: ${operatorId}`,
      };
    }

    const start = Date.now();
    try {
      const result = await operator.execute(ctx);
      result.durationMs = Date.now() - start;
      return result;
    } catch (err) {
      return {
        status: "failure",
        summary: `Operator ${operatorId} threw: ${err instanceof Error ? err.message : String(err)}`,
        durationMs: Date.now() - start,
      };
    }
  }

  get(id: string): Operator | undefined {
    return this.operators.get(id);
  }

  list(): Operator[] {
    return [...this.operators.values()];
  }
}
