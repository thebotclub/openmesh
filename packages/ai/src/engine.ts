/**
 * AIEngine — unified LLM client for OpenMesh.
 *
 * Points the OpenAI SDK at any OpenAI-compatible endpoint:
 *   - LiteLLM proxy (100+ providers): http://localhost:4000
 *   - Ollama local models: http://localhost:11434/v1
 *   - OpenAI direct: https://api.openai.com/v1
 *   - OpenRouter: https://openrouter.ai/api/v1
 *   - vLLM: http://localhost:8000/v1
 *
 * This pattern is borrowed from OpenClaw's provider abstraction and
 * LiteLLM's "one API, any model" philosophy.
 */

import OpenAI from "openai";
import { ContextManager, type CompactionConfig } from "./compaction.js";
import { CostTracker } from "./costTracker.js";
import { FailoverManager, type FailoverConfig } from "./failover.js";

export interface AIEngineConfig {
  /** Base URL for OpenAI-compatible API (default: LiteLLM at localhost:4000) */
  baseUrl?: string;
  /** API key (reads OPENMESH_LLM_API_KEY or OPENAI_API_KEY from env) */
  apiKey?: string;
  /** Default model to use */
  model?: string;
  /** Temperature for completions (default: 0.2 for ops reliability) */
  temperature?: number;
  /** Maximum tokens per response */
  maxTokens?: number;
  /** Context compaction settings */
  compaction?: CompactionConfig;
  /** Failover profiles for multi-provider resilience */
  failover?: FailoverConfig;
}

const DEFAULT_CONFIG: Required<Omit<AIEngineConfig, 'compaction' | 'failover'>> = {
  baseUrl: "http://localhost:4000/v1", // LiteLLM default
  apiKey: "not-needed", // LiteLLM local doesn't require one
  model: "gpt-4o-mini", // sensible default; overridden per-deployment
  temperature: 0.2,
  maxTokens: 4096,
};

export class AIEngine {
  readonly client: OpenAI;
  readonly config: Required<Omit<AIEngineConfig, 'compaction' | 'failover'>>;
  readonly context: ContextManager;
  readonly costs: CostTracker;
  readonly failover?: FailoverManager;

  constructor(config?: AIEngineConfig) {
    const apiKey =
      config?.apiKey ??
      process.env["OPENMESH_LLM_API_KEY"] ??
      process.env["OPENAI_API_KEY"] ??
      DEFAULT_CONFIG.apiKey;

    const baseURL =
      config?.baseUrl ??
      process.env["OPENMESH_LLM_BASE_URL"] ??
      DEFAULT_CONFIG.baseUrl;

    this.config = {
      baseUrl: baseURL,
      apiKey,
      model: config?.model ?? process.env["OPENMESH_LLM_MODEL"] ?? DEFAULT_CONFIG.model,
      temperature: config?.temperature ?? DEFAULT_CONFIG.temperature,
      maxTokens: config?.maxTokens ?? DEFAULT_CONFIG.maxTokens,
    };

    this.client = new OpenAI({
      apiKey: this.config.apiKey,
      baseURL: this.config.baseUrl,
    });

    this.context = new ContextManager(config?.compaction);
    this.costs = new CostTracker();

    if (config?.failover) {
      this.failover = new FailoverManager(config.failover);
    }
  }

  /**
   * Send a chat completion request — the fundamental building block.
   * All higher-level features (goal interpretation, planning, anomaly
   * detection) are built on top of this.
   */
  async chat(
    messages: OpenAI.ChatCompletionMessageParam[],
    options?: {
      model?: string;
      temperature?: number;
      maxTokens?: number;
      responseFormat?: OpenAI.ChatCompletionCreateParams["response_format"];
    },
  ): Promise<OpenAI.ChatCompletion> {
    // Auto-compact if context window is getting full
    let msgs = messages;
    if (this.context.shouldCompact(msgs)) {
      msgs = await this.context.compact(
        msgs,
        (text) => this.prompt(
          'You are a conversation summarizer. Summarize the following conversation transcript concisely, preserving key facts, decisions, and context needed for continuation.',
          text,
          { model: options?.model, temperature: 0.1 },
        ),
      );
    }

    if (this.failover) {
      const { result } = await this.failover.call(async (profile) => {
        const client = new OpenAI({ apiKey: profile.apiKey, baseURL: profile.baseUrl });
        return client.chat.completions.create({
          model: profile.model,
          messages: msgs,
          temperature: options?.temperature ?? this.config.temperature,
          max_tokens: options?.maxTokens ?? this.config.maxTokens,
          ...(options?.responseFormat ? { response_format: options.responseFormat } : {}),
        });
      });
      if (result.usage) {
        this.costs.record(result.model ?? this.config.model, result.usage);
      }
      return result;
    }

    const completion = await this.client.chat.completions.create({
      model: options?.model ?? this.config.model,
      messages: msgs,
      temperature: options?.temperature ?? this.config.temperature,
      max_tokens: options?.maxTokens ?? this.config.maxTokens,
      ...(options?.responseFormat ? { response_format: options.responseFormat } : {}),
    });
    if (completion.usage) {
      this.costs.record(completion.model ?? options?.model ?? this.config.model, completion.usage);
    }
    return completion;
  }

  /**
   * Convenience: single-turn prompt → text response.
   */
  async prompt(
    systemPrompt: string,
    userPrompt: string,
    options?: { model?: string; temperature?: number },
  ): Promise<string> {
    const completion = await this.chat(
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      options,
    );
    return completion.choices[0]?.message?.content ?? "";
  }

  /**
   * Structured output: prompt → parsed JSON.
   * Uses json_object response format for reliable extraction.
   */
  async promptJSON<T = unknown>(
    systemPrompt: string,
    userPrompt: string,
    options?: { model?: string; temperature?: number },
  ): Promise<T> {
    const completion = await this.chat(
      [
        { role: "system", content: systemPrompt + "\n\nRespond with valid JSON only." },
        { role: "user", content: userPrompt },
      ],
      {
        ...options,
        responseFormat: { type: "json_object" },
      },
    );
    const text = completion.choices[0]?.message?.content ?? "{}";
    return JSON.parse(text) as T;
  }
}
