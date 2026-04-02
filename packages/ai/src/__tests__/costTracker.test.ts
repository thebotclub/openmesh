import { describe, it, expect } from 'vitest';
import { CostTracker } from '../costTracker.js';
import { AIEngine } from '../engine.js';

describe('CostTracker', () => {
  it('record() tracks tokens for a model', () => {
    const tracker = new CostTracker();
    tracker.record('gpt-4o-mini', { prompt_tokens: 100, completion_tokens: 50 });

    const models = tracker.getUsageByModel();
    expect(models).toHaveLength(1);
    expect(models[0]!.model).toBe('gpt-4o-mini');
    expect(models[0]!.tokens.inputTokens).toBe(100);
    expect(models[0]!.tokens.outputTokens).toBe(50);
    expect(models[0]!.calls).toBe(1);
  });

  it('record() accumulates across multiple calls', () => {
    const tracker = new CostTracker();
    tracker.record('gpt-4o-mini', { prompt_tokens: 100, completion_tokens: 50 });
    tracker.record('gpt-4o-mini', { prompt_tokens: 200, completion_tokens: 80 });

    const models = tracker.getUsageByModel();
    expect(models).toHaveLength(1);
    expect(models[0]!.calls).toBe(2);
    expect(models[0]!.tokens.inputTokens).toBe(300);
    expect(models[0]!.tokens.outputTokens).toBe(130);
  });

  it('record() handles missing fields (undefined prompt_tokens etc)', () => {
    const tracker = new CostTracker();
    tracker.record('gpt-4o-mini', {});

    const models = tracker.getUsageByModel();
    expect(models).toHaveLength(1);
    expect(models[0]!.tokens.inputTokens).toBe(0);
    expect(models[0]!.tokens.outputTokens).toBe(0);
    expect(models[0]!.tokens.cachedTokens).toBe(0);
    expect(models[0]!.calls).toBe(1);
  });

  it('tracks multiple models separately', () => {
    const tracker = new CostTracker();
    tracker.record('gpt-4o-mini', { prompt_tokens: 100, completion_tokens: 50 });
    tracker.record('gpt-4o', { prompt_tokens: 200, completion_tokens: 80 });

    const models = tracker.getUsageByModel();
    expect(models).toHaveLength(2);
    const mini = models.find(m => m.model === 'gpt-4o-mini');
    const full = models.find(m => m.model === 'gpt-4o');
    expect(mini!.tokens.inputTokens).toBe(100);
    expect(full!.tokens.inputTokens).toBe(200);
  });

  it('getTotalCost() sums across models', () => {
    const tracker = new CostTracker();
    tracker.record('gpt-4o-mini', { prompt_tokens: 1_000_000, completion_tokens: 0 });
    tracker.record('gpt-4o', { prompt_tokens: 1_000_000, completion_tokens: 0 });

    // gpt-4o-mini input: $0.15, gpt-4o input: $2.50
    const total = tracker.getTotalCost();
    expect(total).toBeCloseTo(0.15 + 2.50, 4);
  });

  it('getUsageByModel() returns all model entries', () => {
    const tracker = new CostTracker();
    tracker.record('gpt-4o-mini', { prompt_tokens: 10, completion_tokens: 5 });
    tracker.record('gpt-4o', { prompt_tokens: 20, completion_tokens: 10 });
    tracker.record('gpt-4-turbo', { prompt_tokens: 30, completion_tokens: 15 });

    expect(tracker.getUsageByModel()).toHaveLength(3);
  });

  it('getSummary() includes total calls, tokens, cost, byModel', () => {
    const tracker = new CostTracker();
    tracker.record('gpt-4o-mini', { prompt_tokens: 100, completion_tokens: 50 });
    tracker.record('gpt-4o', { prompt_tokens: 200, completion_tokens: 80 });

    const summary = tracker.getSummary();
    expect(summary.totalCalls).toBe(2);
    expect(summary.totalTokens.inputTokens).toBe(300);
    expect(summary.totalTokens.outputTokens).toBe(130);
    expect(summary.byModel).toHaveLength(2);
    expect(summary.totalCostUsd).toBeGreaterThan(0);
    expect(summary.sessionStartedAt).toBeDefined();
  });

  it('formatSummary() returns human-readable string', () => {
    const tracker = new CostTracker();
    tracker.record('gpt-4o-mini', { prompt_tokens: 100, completion_tokens: 50 });

    const text = tracker.formatSummary();
    expect(text).toContain('=== AI Cost Summary ===');
    expect(text).toContain('Total calls: 1');
    expect(text).toContain('gpt-4o-mini');
    expect(text).toContain('Estimated cost: $');
  });

  it('reset() clears all usage', () => {
    const tracker = new CostTracker();
    tracker.record('gpt-4o-mini', { prompt_tokens: 100, completion_tokens: 50 });
    expect(tracker.getUsageByModel()).toHaveLength(1);

    tracker.reset();
    expect(tracker.getUsageByModel()).toHaveLength(0);
    expect(tracker.getTotalCost()).toBe(0);
    expect(tracker.getSummary().totalCalls).toBe(0);
  });

  it('setPricing() overrides default pricing', () => {
    const tracker = new CostTracker();
    tracker.setPricing('gpt-4o-mini', 1.00, 2.00);

    // 1M input tokens at $1.00/M = $1.00
    tracker.record('gpt-4o-mini', { prompt_tokens: 1_000_000, completion_tokens: 0 });
    expect(tracker.getTotalCost()).toBeCloseTo(1.00, 4);
  });

  it('cached tokens reduce input cost', () => {
    const tracker = new CostTracker();
    // 1M input, 500K cached → billable input = 500K
    tracker.record('gpt-4o', { prompt_tokens: 1_000_000, completion_tokens: 0, cache_read_input_tokens: 500_000 });

    const models = tracker.getUsageByModel();
    expect(models[0]!.tokens.cachedTokens).toBe(500_000);
    // billable = 500K input at $2.50/M = $1.25
    // cached = 500K at 50% of $2.50/M = $0.625
    // total = $1.875
    expect(models[0]!.estimatedCostUsd).toBeCloseTo(1.875, 4);
  });

  it('unknown model returns 0 cost', () => {
    const tracker = new CostTracker();
    tracker.record('totally-unknown-model', { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 });

    expect(tracker.getTotalCost()).toBe(0);
    const models = tracker.getUsageByModel();
    expect(models[0]!.estimatedCostUsd).toBe(0);
    // Tokens are still tracked even without pricing
    expect(models[0]!.tokens.inputTokens).toBe(1_000_000);
  });

  it('prefix matching finds pricing (e.g., "gpt-4o-2024-11-20" matches "gpt-4o")', () => {
    const tracker = new CostTracker();
    tracker.record('gpt-4o-2024-11-20', { prompt_tokens: 1_000_000, completion_tokens: 0 });

    // Should match gpt-4o pricing: $2.50/M input
    expect(tracker.getTotalCost()).toBeCloseTo(2.50, 4);
  });

  it('cost calculation is accurate for gpt-4o-mini with specific token counts', () => {
    const tracker = new CostTracker();
    // 500 input, 200 output, no cache
    // input: (500 / 1M) * $0.15 = $0.000075
    // output: (200 / 1M) * $0.60 = $0.000120
    // total: $0.000195
    tracker.record('gpt-4o-mini', { prompt_tokens: 500, completion_tokens: 200 });

    const cost = tracker.getTotalCost();
    expect(cost).toBeCloseTo(0.000195, 6);
  });

  it('sessionStartedAt is set on construction', () => {
    const before = new Date().toISOString();
    const tracker = new CostTracker();
    const after = new Date().toISOString();

    expect(tracker.sessionStartedAt).toBeDefined();
    expect(tracker.sessionStartedAt >= before).toBe(true);
    expect(tracker.sessionStartedAt <= after).toBe(true);
  });

  it('empty tracker returns zero totals', () => {
    const tracker = new CostTracker();
    const summary = tracker.getSummary();

    expect(summary.totalCalls).toBe(0);
    expect(summary.totalTokens.inputTokens).toBe(0);
    expect(summary.totalTokens.outputTokens).toBe(0);
    expect(summary.totalTokens.cachedTokens).toBe(0);
    expect(summary.totalCostUsd).toBe(0);
    expect(summary.byModel).toHaveLength(0);
  });

  it('formatSummary with multiple models', () => {
    const tracker = new CostTracker();
    tracker.record('gpt-4o-mini', { prompt_tokens: 100, completion_tokens: 50 });
    tracker.record('gpt-4o', { prompt_tokens: 200, completion_tokens: 80 });

    const text = tracker.formatSummary();
    expect(text).toContain('gpt-4o-mini');
    expect(text).toContain('gpt-4o:');
    expect(text).toContain('By model:');
    expect(text).toContain('Total calls: 2');
  });

  it('records cache_read_input_tokens correctly', () => {
    const tracker = new CostTracker();
    tracker.record('gpt-4o', {
      prompt_tokens: 1000,
      completion_tokens: 500,
      cache_read_input_tokens: 300,
    });

    const model = tracker.getUsageByModel()[0]!;
    expect(model.tokens.cachedTokens).toBe(300);
  });

  it('setPricing for a new model enables cost tracking', () => {
    const tracker = new CostTracker();
    tracker.setPricing('my-custom-model', 5.00, 10.00);
    tracker.record('my-custom-model', { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 });

    // input: $5.00, output: $10.00
    expect(tracker.getTotalCost()).toBeCloseTo(15.00, 4);
  });

  it('cost accumulates correctly across multiple calls to same model', () => {
    const tracker = new CostTracker();
    tracker.record('gpt-4o-mini', { prompt_tokens: 500, completion_tokens: 200 });
    tracker.record('gpt-4o-mini', { prompt_tokens: 500, completion_tokens: 200 });

    // Two calls with same tokens should be 2x cost of one
    const singleTracker = new CostTracker();
    singleTracker.record('gpt-4o-mini', { prompt_tokens: 1000, completion_tokens: 400 });

    expect(tracker.getTotalCost()).toBeCloseTo(singleTracker.getTotalCost(), 6);
  });
});

describe('AIEngine cost integration', () => {
  it('has costs field as CostTracker', () => {
    const engine = new AIEngine();
    expect(engine.costs).toBeInstanceOf(CostTracker);
  });

  it('costs starts with empty usage', () => {
    const engine = new AIEngine();
    const summary = engine.costs.getSummary();
    expect(summary.totalCalls).toBe(0);
    expect(summary.totalCostUsd).toBe(0);
    expect(summary.byModel).toHaveLength(0);
  });
});
