import { describe, it, expect, vi, beforeEach } from "vitest";
import type OpenAI from "openai";
import { ContextManager, type CompactionConfig } from "../compaction.js";
import { AIEngine } from "../engine.js";

type ChatMessage = OpenAI.ChatCompletionMessageParam;

const mockSummarizer = vi.fn(
  async (text: string) => `Summary of ${text.length} chars`,
);

// Helper to create messages of approximate token size
function makeMessages(count: number, contentLength = 40): ChatMessage[] {
  const msgs: ChatMessage[] = [];
  for (let i = 0; i < count; i++) {
    msgs.push({
      role: i % 2 === 0 ? "user" : "assistant",
      content: "x".repeat(contentLength),
    });
  }
  return msgs;
}

describe("ContextManager", () => {
  // --- Token estimation ---

  describe("estimateTokens", () => {
    it("returns 0 for empty messages", () => {
      const cm = new ContextManager();
      expect(cm.estimateTokens([])).toBe(0);
    });

    it("estimates a single short message correctly", () => {
      const cm = new ContextManager();
      // 4 role overhead + ceil(12/4) = 4 + 3 = 7
      const tokens = cm.estimateTokens([
        { role: "user", content: "Hello World!" },
      ]);
      expect(tokens).toBe(7);
    });

    it("sums multiple messages correctly", () => {
      const cm = new ContextManager();
      const msgs: ChatMessage[] = [
        { role: "system", content: "You are helpful." }, // 4 + ceil(16/4) = 4 + 4 = 8
        { role: "user", content: "Hi" },                 // 4 + ceil(2/4) = 4 + 1 = 5
      ];
      expect(cm.estimateTokens(msgs)).toBe(13);
    });

    it("counts role overhead of 4 per message", () => {
      const cm = new ContextManager();
      // 3 messages with empty content → 3 * 4 = 12
      const msgs: ChatMessage[] = [
        { role: "user", content: "" },
        { role: "assistant", content: "" },
        { role: "user", content: "" },
      ];
      expect(cm.estimateTokens(msgs)).toBe(12);
    });

    it("handles array content (content parts)", () => {
      const cm = new ContextManager();
      const msgs: ChatMessage[] = [
        {
          role: "user",
          content: [
            { type: "text", text: "Hello" },       // 5 chars
            { type: "text", text: " World" },       // 6 chars
          ],
        },
      ];
      // 4 overhead + ceil(11/4) = 4 + 3 = 7
      expect(cm.estimateTokens(msgs)).toBe(7);
    });
  });

  // --- shouldCompact ---

  describe("shouldCompact", () => {
    it("returns false when below threshold", () => {
      const cm = new ContextManager({ maxContextTokens: 1000, compactionThreshold: 0.8 });
      // Small message: well under 800 tokens
      const msgs: ChatMessage[] = [{ role: "user", content: "Hi" }];
      expect(cm.shouldCompact(msgs)).toBe(false);
    });

    it("returns true when above threshold", () => {
      const cm = new ContextManager({ maxContextTokens: 100, compactionThreshold: 0.8 });
      // Need > 80 tokens: 20 messages with 16-char content → 20 * (4 + 4) = 160
      const msgs = makeMessages(20, 16);
      expect(cm.shouldCompact(msgs)).toBe(true);
    });

    it("handles exact threshold boundary", () => {
      // Exactly at threshold should NOT compact (uses > not >=)
      const cm = new ContextManager({ maxContextTokens: 100, compactionThreshold: 0.5 });
      // 50 tokens exactly: we need tokens = 50. 
      // 5 msgs with 20 chars each: 5 * (4 + 5) = 45 ... need to tune.
      // Let's compute: we want estimateTokens = 50.
      // 1 msg: 4 + ceil(content/4) = 50 → content/4 = 46 → content = 184
      const msgs: ChatMessage[] = [{ role: "user", content: "x".repeat(184) }];
      expect(cm.estimateTokens(msgs)).toBe(50);
      expect(cm.shouldCompact(msgs)).toBe(false); // 50 is NOT > 50
    });
  });

  // --- compact ---

  describe("compact", () => {
    beforeEach(() => {
      mockSummarizer.mockClear();
    });

    it("preserves system prompt (first message) always", async () => {
      const cm = new ContextManager({ keepRecentMessages: 2 });
      const msgs: ChatMessage[] = [
        { role: "system", content: "System prompt" },
        { role: "user", content: "msg1" },
        { role: "assistant", content: "msg2" },
        { role: "user", content: "msg3" },
        { role: "assistant", content: "msg4" },
      ];

      const result = await cm.compact(msgs, mockSummarizer);
      expect(result[0]).toEqual({ role: "system", content: "System prompt" });
    });

    it("preserves last N recent messages", async () => {
      const cm = new ContextManager({ keepRecentMessages: 2 });
      const msgs: ChatMessage[] = [
        { role: "system", content: "System prompt" },
        { role: "user", content: "old1" },
        { role: "assistant", content: "old2" },
        { role: "user", content: "recent1" },
        { role: "assistant", content: "recent2" },
      ];

      const result = await cm.compact(msgs, mockSummarizer);
      const lastTwo = result.slice(-2);
      expect(lastTwo).toEqual([
        { role: "user", content: "recent1" },
        { role: "assistant", content: "recent2" },
      ]);
    });

    it("summarizes middle messages", async () => {
      const cm = new ContextManager({ keepRecentMessages: 1 });
      const msgs: ChatMessage[] = [
        { role: "system", content: "Be helpful" },
        { role: "user", content: "first question" },
        { role: "assistant", content: "first answer" },
        { role: "user", content: "last question" },
      ];

      const result = await cm.compact(msgs, mockSummarizer);
      // Result: system + summary + last 1 message = 3 messages
      expect(result.length).toBe(3);
    });

    it("calls summarizer with middle content transcript", async () => {
      const cm = new ContextManager({ keepRecentMessages: 1 });
      const msgs: ChatMessage[] = [
        { role: "system", content: "Be helpful" },
        { role: "user", content: "question A" },
        { role: "assistant", content: "answer A" },
        { role: "user", content: "final question" },
      ];

      await cm.compact(msgs, mockSummarizer);
      expect(mockSummarizer).toHaveBeenCalledOnce();
      const arg = mockSummarizer.mock.calls[0]![0];
      expect(arg).toContain("[user]: question A");
      expect(arg).toContain("[assistant]: answer A");
      // Should NOT contain the system prompt or the recent message
      expect(arg).not.toContain("Be helpful");
      expect(arg).not.toContain("final question");
    });

    it("returns original if too few messages to compact", async () => {
      const cm = new ContextManager({ keepRecentMessages: 10 });
      const msgs: ChatMessage[] = [
        { role: "system", content: "System" },
        { role: "user", content: "Hi" },
      ];

      const result = await cm.compact(msgs, mockSummarizer);
      expect(result).toBe(msgs); // Same reference
      expect(mockSummarizer).not.toHaveBeenCalled();
    });

    it("summary is a system message with '[Previous conversation summary]' prefix", async () => {
      const cm = new ContextManager({ keepRecentMessages: 1 });
      const msgs: ChatMessage[] = [
        { role: "system", content: "System" },
        { role: "user", content: "old msg" },
        { role: "assistant", content: "old reply" },
        { role: "user", content: "new msg" },
      ];

      const result = await cm.compact(msgs, mockSummarizer);
      const summaryMsg = result[1]!;
      expect(summaryMsg.role).toBe("system");
      expect(typeof summaryMsg.content === "string" && summaryMsg.content.startsWith("[Previous conversation summary]")).toBe(true);
    });

    it("compacted result has fewer tokens than original", async () => {
      const cm = new ContextManager({ keepRecentMessages: 2 });
      const msgs: ChatMessage[] = [
        { role: "system", content: "System prompt here" },
        ...makeMessages(20, 200), // lots of content
        { role: "user", content: "recent1" },
        { role: "assistant", content: "recent2" },
      ];

      const originalTokens = cm.estimateTokens(msgs);
      const result = await cm.compact(msgs, mockSummarizer);
      const compactedTokens = cm.estimateTokens(result);
      expect(compactedTokens).toBeLessThan(originalTokens);
    });

    it("returns original when olderMessages is empty", async () => {
      const cm = new ContextManager({ keepRecentMessages: 3 });
      // 1 system + 3 recent = 4 msgs, keep=3 → olderMessages = slice(1, 4-3) = slice(1,1) = empty
      const msgs: ChatMessage[] = [
        { role: "system", content: "System" },
        { role: "user", content: "a" },
        { role: "assistant", content: "b" },
        { role: "user", content: "c" },
      ];

      const result = await cm.compact(msgs, mockSummarizer);
      expect(result).toBe(msgs);
      expect(mockSummarizer).not.toHaveBeenCalled();
    });
  });

  // --- getStats ---

  describe("getStats", () => {
    it("returns correct messageCount", () => {
      const cm = new ContextManager();
      const msgs = makeMessages(5);
      const stats = cm.getStats(msgs);
      expect(stats.messageCount).toBe(5);
    });

    it("returns correct usagePercent", () => {
      const cm = new ContextManager({ maxContextTokens: 1000 });
      // 1 msg with 396 chars: 4 + ceil(396/4) = 4 + 99 = 103 tokens
      // 103/1000 * 100 = 10.3 → rounds to 10
      const msgs: ChatMessage[] = [
        { role: "user", content: "x".repeat(396) },
      ];
      const stats = cm.getStats(msgs);
      expect(stats.estimatedTokens).toBe(103);
      expect(stats.usagePercent).toBe(10);
    });

    it("needsCompaction matches shouldCompact", () => {
      const cm = new ContextManager({ maxContextTokens: 100, compactionThreshold: 0.5 });
      const smallMsgs: ChatMessage[] = [{ role: "user", content: "Hi" }];
      const bigMsgs = makeMessages(20, 100);

      expect(cm.getStats(smallMsgs).needsCompaction).toBe(cm.shouldCompact(smallMsgs));
      expect(cm.getStats(bigMsgs).needsCompaction).toBe(cm.shouldCompact(bigMsgs));
    });

    it("returns correct maxTokens from config", () => {
      const cm = new ContextManager({ maxContextTokens: 50_000 });
      const stats = cm.getStats([]);
      expect(stats.maxTokens).toBe(50_000);
    });
  });

  // --- Integration with AIEngine ---

  describe("AIEngine integration", () => {
    it("engine.context is a ContextManager instance", () => {
      const engine = new AIEngine();
      expect(engine.context).toBeInstanceOf(ContextManager);
    });

    it("engine.context.config reflects constructor compaction params", () => {
      const compaction: CompactionConfig = {
        maxContextTokens: 64_000,
        compactionThreshold: 0.7,
        keepRecentMessages: 5,
        summaryMaxTokens: 512,
      };
      const engine = new AIEngine({ compaction });
      expect(engine.context.config.maxContextTokens).toBe(64_000);
      expect(engine.context.config.compactionThreshold).toBe(0.7);
      expect(engine.context.config.keepRecentMessages).toBe(5);
      expect(engine.context.config.summaryMaxTokens).toBe(512);
    });
  });
});
