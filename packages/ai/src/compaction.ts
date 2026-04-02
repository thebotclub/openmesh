/**
 * Context Window Compaction — manages LLM context windows by estimating
 * token counts and compacting old messages via summarization.
 *
 * Pattern borrowed from Claude Code's reactive compaction and
 * OpenClaw's transcript compaction.
 */

import type OpenAI from "openai";

export interface CompactionConfig {
  /** Max context window tokens (default: 128000 for GPT-4o) */
  maxContextTokens?: number;
  /** Compact when usage exceeds this fraction of max (default: 0.8) */
  compactionThreshold?: number;
  /** Number of recent messages to always preserve (default: 10) */
  keepRecentMessages?: number;
  /** Max tokens for the compaction summary (default: 1024) */
  summaryMaxTokens?: number;
}

type ChatMessage = OpenAI.ChatCompletionMessageParam;

/**
 * Manages context windows by estimating token counts and
 * compacting old messages via summarization when approaching limits.
 */
export class ContextManager {
  readonly config: Required<CompactionConfig>;

  constructor(config?: CompactionConfig) {
    this.config = {
      maxContextTokens: config?.maxContextTokens ?? 128_000,
      compactionThreshold: config?.compactionThreshold ?? 0.8,
      keepRecentMessages: config?.keepRecentMessages ?? 10,
      summaryMaxTokens: config?.summaryMaxTokens ?? 1024,
    };
  }

  /**
   * Estimate token count for a message array.
   * Uses the standard heuristic: ~4 characters per token.
   * Accounts for role overhead (~4 tokens per message).
   */
  estimateTokens(messages: ChatMessage[]): number {
    let total = 0;
    for (const msg of messages) {
      // Role overhead
      total += 4;
      // Content
      const content =
        typeof msg.content === "string"
          ? msg.content
          : Array.isArray(msg.content)
            ? msg.content.map((p) => ("text" in p ? p.text : "")).join("")
            : "";
      total += Math.ceil(content.length / 4);
    }
    return total;
  }

  /**
   * Check if messages should be compacted.
   */
  shouldCompact(messages: ChatMessage[]): boolean {
    const tokens = this.estimateTokens(messages);
    return tokens > this.config.maxContextTokens * this.config.compactionThreshold;
  }

  /**
   * Compact messages by summarizing older messages and keeping recent ones.
   *
   * Strategy:
   * 1. The FIRST message (system prompt) is always preserved intact
   * 2. The last `keepRecentMessages` messages are preserved intact
   * 3. Everything in between is summarized into a single "system" message
   *
   * @param messages - The full message array
   * @param summarizer - Function that takes text and returns a summary
   * @returns Compacted message array
   */
  async compact(
    messages: ChatMessage[],
    summarizer: (text: string) => Promise<string>,
  ): Promise<ChatMessage[]> {
    const keep = this.config.keepRecentMessages;

    // If there aren't enough messages to compact, return as-is
    if (messages.length <= keep + 1) {
      return messages;
    }

    // Split: system prompt | older messages | recent messages
    const systemPrompt = messages[0];
    const olderMessages = messages.slice(1, messages.length - keep);
    const recentMessages = messages.slice(messages.length - keep);

    // Nothing to compact
    if (olderMessages.length === 0) {
      return messages;
    }

    // Build a text representation of older messages for summarization
    const transcript = olderMessages
      .map((m) => {
        const role = m.role;
        const content =
          typeof m.content === "string" ? m.content : JSON.stringify(m.content);
        return `[${role}]: ${content}`;
      })
      .join("\n\n");

    // Summarize
    const summary = await summarizer(transcript);

    // Reconstruct: system prompt + summary message + recent messages
    const compactedSummary: ChatMessage = {
      role: "system",
      content: `[Previous conversation summary]\n${summary}`,
    };

    return [systemPrompt!, compactedSummary, ...recentMessages];
  }

  /**
   * Get compaction stats for debugging/telemetry.
   */
  getStats(messages: ChatMessage[]): {
    messageCount: number;
    estimatedTokens: number;
    maxTokens: number;
    usagePercent: number;
    needsCompaction: boolean;
  } {
    const estimatedTokens = this.estimateTokens(messages);
    return {
      messageCount: messages.length,
      estimatedTokens,
      maxTokens: this.config.maxContextTokens,
      usagePercent: Math.round(
        (estimatedTokens / this.config.maxContextTokens) * 100,
      ),
      needsCompaction: this.shouldCompact(messages),
    };
  }
}
