/**
 * CostTracker — per-model token accumulation and cost estimation.
 *
 * Borrowed from Claude Code's cost tracking pattern: accumulate token
 * usage per model across calls and estimate USD cost from known pricing.
 */

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
}

export interface ModelUsage {
  model: string;
  calls: number;
  tokens: TokenUsage;
  estimatedCostUsd: number;
}

export interface CostSummary {
  totalCalls: number;
  totalTokens: TokenUsage;
  totalCostUsd: number;
  byModel: ModelUsage[];
  sessionStartedAt: string;
}

// Pricing per 1M tokens (input/output) for common models
// Users can override/add via setPricing()
const DEFAULT_PRICING: Record<string, { inputPer1M: number; outputPer1M: number }> = {
  'gpt-4o': { inputPer1M: 2.50, outputPer1M: 10.00 },
  'gpt-4o-mini': { inputPer1M: 0.15, outputPer1M: 0.60 },
  'gpt-4-turbo': { inputPer1M: 10.00, outputPer1M: 30.00 },
  'gpt-3.5-turbo': { inputPer1M: 0.50, outputPer1M: 1.50 },
  'claude-3-5-sonnet-20241022': { inputPer1M: 3.00, outputPer1M: 15.00 },
  'claude-3-5-haiku-20241022': { inputPer1M: 0.80, outputPer1M: 4.00 },
  'claude-3-opus-20240229': { inputPer1M: 15.00, outputPer1M: 75.00 },
  'claude-sonnet-4-20250514': { inputPer1M: 3.00, outputPer1M: 15.00 },
  'claude-haiku-4-20250514': { inputPer1M: 0.80, outputPer1M: 4.00 },
};

export class CostTracker {
  private usage = new Map<string, ModelUsage>();
  private pricing: Record<string, { inputPer1M: number; outputPer1M: number }>;
  readonly sessionStartedAt: string;

  constructor() {
    this.pricing = { ...DEFAULT_PRICING };
    this.sessionStartedAt = new Date().toISOString();
  }

  /** Record token usage from a completion response */
  record(model: string, usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; cache_read_input_tokens?: number }): void {
    const inputTokens = usage.prompt_tokens ?? 0;
    const outputTokens = usage.completion_tokens ?? 0;
    const cachedTokens = usage.cache_read_input_tokens ?? 0;

    let entry = this.usage.get(model);
    if (!entry) {
      entry = {
        model,
        calls: 0,
        tokens: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
        estimatedCostUsd: 0,
      };
      this.usage.set(model, entry);
    }

    entry.calls++;
    entry.tokens.inputTokens += inputTokens;
    entry.tokens.outputTokens += outputTokens;
    entry.tokens.cachedTokens += cachedTokens;
    entry.estimatedCostUsd = this.calculateCost(model, entry.tokens);
  }

  /** Calculate cost for a model's accumulated tokens */
  private calculateCost(model: string, tokens: TokenUsage): number {
    // Try exact match first, then prefix match (for versioned model names)
    const pricing = this.pricing[model] ?? this.findPricingByPrefix(model);
    if (!pricing) return 0; // Unknown model — can't price

    const billableInput = tokens.inputTokens - tokens.cachedTokens;
    const inputCost = (Math.max(0, billableInput) / 1_000_000) * pricing.inputPer1M;
    const outputCost = (tokens.outputTokens / 1_000_000) * pricing.outputPer1M;
    // Cached tokens are typically 50% off input price
    const cachedCost = (tokens.cachedTokens / 1_000_000) * (pricing.inputPer1M * 0.5);
    return inputCost + outputCost + cachedCost;
  }

  private findPricingByPrefix(model: string): { inputPer1M: number; outputPer1M: number } | undefined {
    for (const [key, value] of Object.entries(this.pricing)) {
      if (model.startsWith(key) || key.startsWith(model)) return value;
    }
    return undefined;
  }

  /** Set or override pricing for a model */
  setPricing(model: string, inputPer1M: number, outputPer1M: number): void {
    this.pricing[model] = { inputPer1M, outputPer1M };
  }

  /** Get total cost across all models */
  getTotalCost(): number {
    let total = 0;
    for (const entry of this.usage.values()) total += entry.estimatedCostUsd;
    return total;
  }

  /** Get usage breakdown by model */
  getUsageByModel(): ModelUsage[] {
    return [...this.usage.values()];
  }

  /** Get a full cost summary */
  getSummary(): CostSummary {
    const byModel = this.getUsageByModel();
    const totalTokens: TokenUsage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
    let totalCalls = 0;

    for (const m of byModel) {
      totalCalls += m.calls;
      totalTokens.inputTokens += m.tokens.inputTokens;
      totalTokens.outputTokens += m.tokens.outputTokens;
      totalTokens.cachedTokens += m.tokens.cachedTokens;
    }

    return {
      totalCalls,
      totalTokens,
      totalCostUsd: this.getTotalCost(),
      byModel,
      sessionStartedAt: this.sessionStartedAt,
    };
  }

  /** Format a human-readable summary string */
  formatSummary(): string {
    const s = this.getSummary();
    const lines = [
      `=== AI Cost Summary ===`,
      `Session: ${s.sessionStartedAt}`,
      `Total calls: ${s.totalCalls}`,
      `Total tokens: ${s.totalTokens.inputTokens.toLocaleString()} in / ${s.totalTokens.outputTokens.toLocaleString()} out`,
      `Estimated cost: $${s.totalCostUsd.toFixed(4)}`,
    ];

    if (s.byModel.length > 0) {
      lines.push('', 'By model:');
      for (const m of s.byModel) {
        lines.push(`  ${m.model}: ${m.calls} calls, ${m.tokens.inputTokens + m.tokens.outputTokens} tokens, $${m.estimatedCostUsd.toFixed(4)}`);
      }
    }

    return lines.join('\n');
  }

  /** Reset all tracked usage */
  reset(): void {
    this.usage.clear();
  }
}
