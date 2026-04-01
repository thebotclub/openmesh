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
}

const DEFAULT_CONFIG: Required<AIEngineConfig> = {
  baseUrl: "http://localhost:4000/v1", // LiteLLM default
  apiKey: "not-needed", // LiteLLM local doesn't require one
  model: "gpt-4o-mini", // sensible default; overridden per-deployment
  temperature: 0.2,
  maxTokens: 4096,
};

export class AIEngine {
  readonly client: OpenAI;
  readonly config: Required<AIEngineConfig>;

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
    return this.client.chat.completions.create({
      model: options?.model ?? this.config.model,
      messages,
      temperature: options?.temperature ?? this.config.temperature,
      max_tokens: options?.maxTokens ?? this.config.maxTokens,
      ...(options?.responseFormat ? { response_format: options.responseFormat } : {}),
    });
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
