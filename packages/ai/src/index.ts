/**
 * @openmesh/ai — LLM-powered intelligence layer for OpenMesh.
 *
 * Uses the OpenAI SDK pointed at LiteLLM proxy (or any OpenAI-compatible API)
 * so we get 100+ model providers without building provider-specific code.
 *
 * WHY OPENAI SDK + LITELLM (not reinventing the wheel):
 *   - LiteLLM (https://github.com/BerriAI/litellm) provides a unified
 *     OpenAI-compatible proxy for Anthropic, Google, Cohere, Ollama, vLLM,
 *     Azure, Bedrock, Vertex, HuggingFace, and 100+ more providers.
 *   - We use the standard OpenAI Node SDK which works with any
 *     OpenAI-compatible endpoint (LiteLLM, Ollama, vLLM, OpenRouter, etc.)
 *   - Users choose their backend: `OPENMESH_LLM_BASE_URL=http://localhost:4000`
 *     for LiteLLM, or direct OpenAI/Anthropic/Ollama endpoints.
 *   - Cost tracking, rate limiting, caching, and load balancing are handled
 *     by LiteLLM at the proxy layer — we don't reimplement any of it.
 */

export { AIEngine, type AIEngineConfig } from "./engine.js";
export { GoalInterpreter, type InterpretedGoal } from "./goalInterpreter.js";
export { OperatorPlanner, type ExecutionPlan, type PlannedStep } from "./planner.js";
export { AnomalyDetector, type Anomaly } from "./anomalyDetector.js";
export { AIOperator } from "./aiOperator.js";
export { RAGContextBuilder, buildMeshContext, type RAGContextConfig, type RAGSource } from "./ragContext.js";
export { RefineSession, type RefineSessionConfig } from "./refineSession.js";
