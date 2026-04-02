/**
 * LLM Failover & Key Rotation — multi-provider resilience for OpenMesh.
 *
 * Borrowed from Claude Code's fallback model pattern and OpenClaw's
 * auth profile rotation. Rotates through LLM profiles with exponential
 * backoff on retryable errors (429, 5xx, network failures).
 */

export interface LLMProfile {
  /** Profile name for logging */
  name: string;
  /** Base URL for OpenAI-compatible API */
  baseUrl: string;
  /** API key */
  apiKey: string;
  /** Model name */
  model: string;
  /** Priority (lower = tried first) */
  priority?: number;
}

export interface FailoverConfig {
  /** LLM profiles to rotate through */
  profiles: LLMProfile[];
  /** Max retries per profile before rotating (default: 2) */
  maxRetriesPerProfile?: number;
  /** Base delay for exponential backoff in ms (default: 500) */
  baseDelayMs?: number;
  /** Maximum backoff delay in ms (default: 30000) */
  maxDelayMs?: number;
  /** Backoff multiplier (default: 2) */
  backoffMultiplier?: number;
}

export interface FailoverResult<T> {
  result: T;
  profile: LLMProfile;
  attempts: number;
}

/**
 * Manages LLM failover across multiple profiles with exponential backoff.
 *
 * Pattern: Try profile[0] → on retryable error, backoff+retry → if exhausted,
 * rotate to profile[1] → repeat → if all profiles exhausted, throw.
 *
 * Retryable HTTP errors: 429 (rate limit), 500, 502, 503, 529 (capacity).
 * Non-retryable: 400, 401, 403, 404.
 */
export class FailoverManager {
  readonly config: Required<FailoverConfig>;
  private sortedProfiles: LLMProfile[];

  constructor(config: FailoverConfig) {
    if (!config.profiles.length) throw new Error('FailoverManager requires at least one profile');
    this.config = {
      profiles: config.profiles,
      maxRetriesPerProfile: config.maxRetriesPerProfile ?? 2,
      baseDelayMs: config.baseDelayMs ?? 500,
      maxDelayMs: config.maxDelayMs ?? 30_000,
      backoffMultiplier: config.backoffMultiplier ?? 2,
    };
    // Sort by priority (lower first), stable sort
    this.sortedProfiles = [...this.config.profiles].sort(
      (a, b) => (a.priority ?? 0) - (b.priority ?? 0),
    );
  }

  /**
   * Execute an async function with failover across profiles.
   * @param fn - Receives the active LLMProfile, returns a promise
   */
  async call<T>(fn: (profile: LLMProfile) => Promise<T>): Promise<FailoverResult<T>> {
    let totalAttempts = 0;
    const errors: Error[] = [];

    for (const profile of this.sortedProfiles) {
      for (let retry = 0; retry <= this.config.maxRetriesPerProfile; retry++) {
        totalAttempts++;
        try {
          const result = await fn(profile);
          return { result, profile, attempts: totalAttempts };
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          errors.push(error);

          if (!this.isRetryable(error)) {
            throw error; // Non-retryable — bail immediately
          }

          // If more retries left for this profile, backoff
          if (retry < this.config.maxRetriesPerProfile) {
            const delay = Math.min(
              this.config.baseDelayMs * this.config.backoffMultiplier ** retry,
              this.config.maxDelayMs,
            );
            await this.sleep(delay);
          }
          // Otherwise, rotate to next profile
        }
      }
    }

    // All profiles exhausted
    const lastError = errors[errors.length - 1]!;
    throw new AllProfilesExhaustedError(
      `All ${this.sortedProfiles.length} LLM profiles exhausted after ${totalAttempts} attempts`,
      errors,
      lastError,
    );
  }

  /** Check if an error is retryable (rate limit, server errors) */
  private isRetryable(error: Error): boolean {
    // Check for HTTP status codes (OpenAI SDK puts these in error.status or error.code)
    const status = (error as any).status ?? (error as any).statusCode;
    if (typeof status === 'number') {
      return [429, 500, 502, 503, 529].includes(status);
    }
    // Check for network errors
    const msg = error.message.toLowerCase();
    return msg.includes('econnrefused') ||
           msg.includes('econnreset') ||
           msg.includes('etimedout') ||
           msg.includes('rate limit') ||
           msg.includes('too many requests') ||
           msg.includes('overloaded') ||
           msg.includes('capacity');
  }

  /** Sleeper — extracted for test mocking */
  protected sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export class AllProfilesExhaustedError extends Error {
  constructor(
    message: string,
    readonly errors: Error[],
    readonly lastError: Error,
  ) {
    super(message);
    this.name = 'AllProfilesExhaustedError';
  }
}
