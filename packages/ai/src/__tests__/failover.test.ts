import { describe, it, expect, vi } from 'vitest';
import {
  FailoverManager,
  AllProfilesExhaustedError,
  type LLMProfile,
} from '../failover.js';
import { AIEngine } from '../engine.js';

// Subclass that skips real sleep for fast tests
class TestableFailover extends FailoverManager {
  sleepCalls: number[] = [];
  protected override sleep(ms: number): Promise<void> {
    this.sleepCalls.push(ms);
    return Promise.resolve();
  }
}

function makeProfile(overrides: Partial<LLMProfile> & { name: string }): LLMProfile {
  return {
    baseUrl: 'http://localhost:4000/v1',
    apiKey: 'test-key',
    model: 'test-model',
    ...overrides,
  };
}

function makeError(status: number, message = 'Error'): Error {
  return Object.assign(new Error(message), { status });
}

describe('FailoverManager', () => {
  describe('constructor', () => {
    it('throws on empty profiles array', () => {
      expect(() => new FailoverManager({ profiles: [] })).toThrow(
        'FailoverManager requires at least one profile',
      );
    });

    it('applies default config values', () => {
      const fm = new FailoverManager({
        profiles: [makeProfile({ name: 'a' })],
      });
      expect(fm.config.maxRetriesPerProfile).toBe(2);
      expect(fm.config.baseDelayMs).toBe(500);
      expect(fm.config.maxDelayMs).toBe(30_000);
      expect(fm.config.backoffMultiplier).toBe(2);
    });

    it('respects custom config values', () => {
      const fm = new FailoverManager({
        profiles: [makeProfile({ name: 'a' })],
        maxRetriesPerProfile: 5,
        baseDelayMs: 100,
        maxDelayMs: 10_000,
        backoffMultiplier: 3,
      });
      expect(fm.config.maxRetriesPerProfile).toBe(5);
      expect(fm.config.baseDelayMs).toBe(100);
      expect(fm.config.maxDelayMs).toBe(10_000);
      expect(fm.config.backoffMultiplier).toBe(3);
    });

    it('sorts profiles by priority (lower first)', async () => {
      const low = makeProfile({ name: 'low', priority: 10 });
      const high = makeProfile({ name: 'high', priority: 1 });
      const mid = makeProfile({ name: 'mid', priority: 5 });

      const fm = new TestableFailover({
        profiles: [low, mid, high],
        maxRetriesPerProfile: 0, // no retries, just try each once
      });

      const seen: string[] = [];
      const fn = vi.fn(async (profile: LLMProfile) => {
        seen.push(profile.name);
        throw makeError(500);
      });

      await expect(fm.call(fn)).rejects.toThrow(AllProfilesExhaustedError);
      expect(seen).toEqual(['high', 'mid', 'low']);
    });
  });

  describe('call()', () => {
    it('returns result, profile, and attempts=1 on first success', async () => {
      const profile = makeProfile({ name: 'primary' });
      const fm = new TestableFailover({ profiles: [profile] });

      const res = await fm.call(async () => 'ok');
      expect(res.result).toBe('ok');
      expect(res.profile.name).toBe('primary');
      expect(res.attempts).toBe(1);
    });

    it('retries on 429 (rate limit) error', async () => {
      const fm = new TestableFailover({
        profiles: [makeProfile({ name: 'a' })],
        maxRetriesPerProfile: 2,
      });

      let calls = 0;
      const res = await fm.call(async () => {
        calls++;
        if (calls < 3) throw makeError(429, 'Rate limited');
        return 'success';
      });

      expect(res.result).toBe('success');
      expect(res.attempts).toBe(3);
    });

    it('retries on 500 error', async () => {
      const fm = new TestableFailover({
        profiles: [makeProfile({ name: 'a' })],
        maxRetriesPerProfile: 1,
      });

      let calls = 0;
      const res = await fm.call(async () => {
        calls++;
        if (calls === 1) throw makeError(500);
        return 'recovered';
      });

      expect(res.result).toBe('recovered');
      expect(res.attempts).toBe(2);
    });

    it('retries on 502 error', async () => {
      const fm = new TestableFailover({
        profiles: [makeProfile({ name: 'a' })],
        maxRetriesPerProfile: 1,
      });

      let calls = 0;
      const res = await fm.call(async () => {
        calls++;
        if (calls === 1) throw makeError(502);
        return 'ok';
      });
      expect(res.attempts).toBe(2);
    });

    it('retries on 503 error', async () => {
      const fm = new TestableFailover({
        profiles: [makeProfile({ name: 'a' })],
        maxRetriesPerProfile: 1,
      });

      let calls = 0;
      const res = await fm.call(async () => {
        calls++;
        if (calls === 1) throw makeError(503);
        return 'ok';
      });
      expect(res.attempts).toBe(2);
    });

    it('retries on 529 (capacity) error', async () => {
      const fm = new TestableFailover({
        profiles: [makeProfile({ name: 'a' })],
        maxRetriesPerProfile: 1,
      });

      let calls = 0;
      const res = await fm.call(async () => {
        calls++;
        if (calls === 1) throw makeError(529);
        return 'ok';
      });
      expect(res.attempts).toBe(2);
    });

    it('does NOT retry on 400 error (throws immediately)', async () => {
      const fm = new TestableFailover({
        profiles: [makeProfile({ name: 'a' }), makeProfile({ name: 'b' })],
      });

      const err = makeError(400, 'Bad request');
      await expect(fm.call(async () => { throw err; })).rejects.toThrow('Bad request');
    });

    it('does NOT retry on 401 error (throws immediately)', async () => {
      const fm = new TestableFailover({
        profiles: [makeProfile({ name: 'a' }), makeProfile({ name: 'b' })],
      });

      await expect(
        fm.call(async () => { throw makeError(401, 'Unauthorized'); }),
      ).rejects.toThrow('Unauthorized');
    });

    it('does NOT retry on 403 error (throws immediately)', async () => {
      const fm = new TestableFailover({
        profiles: [makeProfile({ name: 'a' }), makeProfile({ name: 'b' })],
      });

      await expect(
        fm.call(async () => { throw makeError(403, 'Forbidden'); }),
      ).rejects.toThrow('Forbidden');
    });

    it('does NOT retry on 404 error (throws immediately)', async () => {
      const fm = new TestableFailover({
        profiles: [makeProfile({ name: 'a' })],
      });

      await expect(
        fm.call(async () => { throw makeError(404, 'Not found'); }),
      ).rejects.toThrow('Not found');
    });

    it('applies exponential backoff delays between retries', async () => {
      const fm = new TestableFailover({
        profiles: [makeProfile({ name: 'a' })],
        maxRetriesPerProfile: 3,
        baseDelayMs: 100,
        backoffMultiplier: 2,
      });

      await expect(
        fm.call(async () => { throw makeError(500); }),
      ).rejects.toThrow(AllProfilesExhaustedError);

      // retries: 0→1 (100*2^0=100), 1→2 (100*2^1=200), 2→3 (100*2^2=400)
      expect(fm.sleepCalls).toEqual([100, 200, 400]);
    });

    it('caps delay at maxDelayMs', async () => {
      const fm = new TestableFailover({
        profiles: [makeProfile({ name: 'a' })],
        maxRetriesPerProfile: 3,
        baseDelayMs: 10_000,
        maxDelayMs: 15_000,
        backoffMultiplier: 3,
      });

      await expect(
        fm.call(async () => { throw makeError(500); }),
      ).rejects.toThrow(AllProfilesExhaustedError);

      // 10000*3^0=10000, 10000*3^1=30000→capped 15000, 10000*3^2=90000→capped 15000
      expect(fm.sleepCalls).toEqual([10_000, 15_000, 15_000]);
    });

    it('rotates to next profile after maxRetries exhausted', async () => {
      const p1 = makeProfile({ name: 'primary', priority: 1 });
      const p2 = makeProfile({ name: 'secondary', priority: 2 });

      const fm = new TestableFailover({
        profiles: [p1, p2],
        maxRetriesPerProfile: 1,
      });

      const seen: string[] = [];
      let totalCalls = 0;
      const res = await fm.call(async (profile) => {
        seen.push(profile.name);
        totalCalls++;
        // Fail on primary (2 attempts), succeed on secondary
        if (profile.name === 'primary') throw makeError(429);
        return 'from-secondary';
      });

      expect(res.result).toBe('from-secondary');
      expect(res.profile.name).toBe('secondary');
      expect(seen).toEqual(['primary', 'primary', 'secondary']);
    });

    it('throws AllProfilesExhaustedError when all profiles fail', async () => {
      const fm = new TestableFailover({
        profiles: [makeProfile({ name: 'a' }), makeProfile({ name: 'b' })],
        maxRetriesPerProfile: 1,
      });

      try {
        await fm.call(async () => { throw makeError(500, 'server down'); });
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(AllProfilesExhaustedError);
        const exhausted = err as AllProfilesExhaustedError;
        expect(exhausted.name).toBe('AllProfilesExhaustedError');
        expect(exhausted.message).toContain('2 LLM profiles exhausted');
        expect(exhausted.message).toContain('4 attempts');
      }
    });

    it('AllProfilesExhaustedError contains all errors and lastError', async () => {
      const fm = new TestableFailover({
        profiles: [makeProfile({ name: 'a' })],
        maxRetriesPerProfile: 1,
      });

      try {
        let n = 0;
        await fm.call(async () => { throw makeError(500, `fail-${n++}`); });
        expect.unreachable('should have thrown');
      } catch (err) {
        const exhausted = err as AllProfilesExhaustedError;
        expect(exhausted.errors).toHaveLength(2);
        expect(exhausted.errors[0]!.message).toBe('fail-0');
        expect(exhausted.errors[1]!.message).toBe('fail-1');
        expect(exhausted.lastError.message).toBe('fail-1');
      }
    });

    it('retries on ECONNREFUSED network error', async () => {
      const fm = new TestableFailover({
        profiles: [makeProfile({ name: 'a' })],
        maxRetriesPerProfile: 1,
      });

      let calls = 0;
      const res = await fm.call(async () => {
        calls++;
        if (calls === 1) throw new Error('connect ECONNREFUSED 127.0.0.1:4000');
        return 'ok';
      });
      expect(res.attempts).toBe(2);
    });

    it('retries on ECONNRESET network error', async () => {
      const fm = new TestableFailover({
        profiles: [makeProfile({ name: 'a' })],
        maxRetriesPerProfile: 1,
      });

      let calls = 0;
      const res = await fm.call(async () => {
        calls++;
        if (calls === 1) throw new Error('read ECONNRESET');
        return 'ok';
      });
      expect(res.attempts).toBe(2);
    });

    it('retries on ETIMEDOUT network error', async () => {
      const fm = new TestableFailover({
        profiles: [makeProfile({ name: 'a' })],
        maxRetriesPerProfile: 1,
      });

      let calls = 0;
      const res = await fm.call(async () => {
        calls++;
        if (calls === 1) throw new Error('connect ETIMEDOUT');
        return 'ok';
      });
      expect(res.attempts).toBe(2);
    });

    it('retries on "rate limit" message-based error', async () => {
      const fm = new TestableFailover({
        profiles: [makeProfile({ name: 'a' })],
        maxRetriesPerProfile: 1,
      });

      let calls = 0;
      const res = await fm.call(async () => {
        calls++;
        if (calls === 1) throw new Error('Rate limit exceeded for model');
        return 'ok';
      });
      expect(res.attempts).toBe(2);
    });

    it('retries on "too many requests" message-based error', async () => {
      const fm = new TestableFailover({
        profiles: [makeProfile({ name: 'a' })],
        maxRetriesPerProfile: 1,
      });

      let calls = 0;
      const res = await fm.call(async () => {
        calls++;
        if (calls === 1) throw new Error('Too many requests, please slow down');
        return 'ok';
      });
      expect(res.attempts).toBe(2);
    });

    it('retries on "overloaded" message-based error', async () => {
      const fm = new TestableFailover({
        profiles: [makeProfile({ name: 'a' })],
        maxRetriesPerProfile: 1,
      });

      let calls = 0;
      const res = await fm.call(async () => {
        calls++;
        if (calls === 1) throw new Error('Model is overloaded');
        return 'ok';
      });
      expect(res.attempts).toBe(2);
    });

    it('retries on "capacity" message-based error', async () => {
      const fm = new TestableFailover({
        profiles: [makeProfile({ name: 'a' })],
        maxRetriesPerProfile: 1,
      });

      let calls = 0;
      const res = await fm.call(async () => {
        calls++;
        if (calls === 1) throw new Error('Insufficient capacity');
        return 'ok';
      });
      expect(res.attempts).toBe(2);
    });

    it('wraps non-Error throws into Error', async () => {
      const fm = new TestableFailover({
        profiles: [makeProfile({ name: 'a' })],
        maxRetriesPerProfile: 0,
      });

      // String throw with no retryable pattern is non-retryable, thrown as Error
      await expect(
        fm.call(async () => { throw 'string-error'; }),
      ).rejects.toThrow('string-error');
    });

    it('tries multiple profiles in priority order with full rotation', async () => {
      const profiles = [
        makeProfile({ name: 'c', priority: 3 }),
        makeProfile({ name: 'a', priority: 1 }),
        makeProfile({ name: 'b', priority: 2 }),
      ];

      const fm = new TestableFailover({
        profiles,
        maxRetriesPerProfile: 0,
      });

      const seen: string[] = [];
      // Fail on 'a' and 'b', succeed on 'c'
      const res = await fm.call(async (profile) => {
        seen.push(profile.name);
        if (profile.name !== 'c') throw makeError(500);
        return 'from-c';
      });

      expect(seen).toEqual(['a', 'b', 'c']);
      expect(res.result).toBe('from-c');
      expect(res.profile.name).toBe('c');
      expect(res.attempts).toBe(3);
    });
  });
});

describe('AIEngine failover integration', () => {
  it('creates FailoverManager when failover config is provided', () => {
    const engine = new AIEngine({
      failover: {
        profiles: [makeProfile({ name: 'primary' })],
      },
    });
    expect(engine.failover).toBeDefined();
    expect(engine.failover).toBeInstanceOf(FailoverManager);
  });

  it('has undefined failover when no failover config', () => {
    const engine = new AIEngine();
    expect(engine.failover).toBeUndefined();
  });
});
