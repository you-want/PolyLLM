import { describe, expect, it } from 'vitest'
import { PolyLLMError } from '../src/errors.js'
import {
  computeBackoffMs,
  isRetryableErrorCategory,
  maxAttempts,
  withRetries,
} from '../src/retry.js'

describe('maxAttempts', () => {
  it('defaults to 3 total attempts', () => {
    expect(maxAttempts(undefined)).toBe(3)
    expect(maxAttempts({})).toBe(3)
  })

  it('respects an explicit maxAttempts', () => {
    expect(maxAttempts({ maxAttempts: 0 })).toBe(1)
    expect(maxAttempts({ maxAttempts: 5 })).toBe(6)
  })
})

describe('isRetryableErrorCategory', () => {
  it('allows only transient categories', () => {
    expect(isRetryableErrorCategory('rate_limited')).toBe(true)
    expect(isRetryableErrorCategory('server')).toBe(true)
    expect(isRetryableErrorCategory('connection')).toBe(true)
    expect(isRetryableErrorCategory('auth')).toBe(false)
    expect(isRetryableErrorCategory('cancelled')).toBe(false)
    expect(isRetryableErrorCategory('timeout')).toBe(false)
    expect(isRetryableErrorCategory('parse')).toBe(false)
  })
})

describe('computeBackoffMs', () => {
  it('defaults: base 500ms with 0.25 jitter, no retry-after', () => {
    // Deterministic random = 0 → no jitter added.
    expect(computeBackoffMs(undefined, undefined, 1, () => 0)).toBe(500)
    // attempt 2 → 1000ms
    expect(computeBackoffMs(undefined, undefined, 2, () => 0)).toBe(1000)
    // attempt 3 → 2000ms
    expect(computeBackoffMs(undefined, undefined, 3, () => 0)).toBe(2000)
  })

  it('adds jitter up to the configured ratio', () => {
    // jitter=0.25, random=1 → +25% of 500 = 625
    expect(computeBackoffMs({ jitter: 0.25 }, undefined, 1, () => 1)).toBe(625)
  })

  it('closes under the maxDelay cap', () => {
    // 500 * 2^9 = 256000 → capped at default 8000
    expect(computeBackoffMs(undefined, undefined, 10, () => 0)).toBe(8000)
  })

  it('honors a positive Retry-After over the backoff', () => {
    expect(computeBackoffMs(undefined, 3, 5, () => 0)).toBe(3000)
  })

  it('caps Retry-After under maxDelay too', () => {
    // 60s retry-after → capped to 8000ms
    expect(computeBackoffMs(undefined, 60, 1, () => 0)).toBe(8000)
  })
})

function providerError(category: 'auth' | 'server' | 'rate_limited', retryAfterSeconds?: number) {
  const details: Record<string, unknown> = {
    provider: 'openai',
    category,
    retryable: category !== 'auth',
  }
  if (retryAfterSeconds !== undefined) details.retryAfterSeconds = retryAfterSeconds
  return new PolyLLMError('PROVIDER_ERROR', 'x', details)
}

describe('withRetries', () => {
  it('returns the result on first success, no retry', async () => {
    let calls = 0
    const { result, attempts, outcome } = await withRetries(
      async () => {
        calls++
        return 'ok'
      },
      { policy: { maxAttempts: 2 }, now: () => 0 },
    )
    expect(result).toBe('ok')
    expect(attempts).toBe(1)
    expect(outcome).toBe('succeeded')
    expect(calls).toBe(1)
  })

  it('retries transient failures until success', async () => {
    const errors = ['server', 'rate_limited'] as const
    let calls = 0
    const { result, attempts, outcome } = await withRetries(
      async () => {
        calls++
        if (calls <= errors.length) throw providerError(errors[calls - 1])
        return 'ok'
      },
      { policy: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2 }, now: () => 0, random: () => 0 },
    )
    expect(result).toBe('ok')
    expect(attempts).toBe(3)
    expect(outcome).toBe('retried')
  })

  it('does not retry non-retryable categories', async () => {
    let calls = 0
    await expect(
      withRetries(
        async () => {
          calls++
          throw providerError('auth')
        },
        { policy: { maxAttempts: 5 }, now: () => 0 },
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_ERROR', details: { category: 'auth' } })
    expect(calls).toBe(1)
  })

  it('exhausts the attempt budget and rethrows', async () => {
    let calls = 0
    await expect(
      withRetries(
        async () => {
          calls++
          throw providerError('server')
        },
        { policy: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 2 }, now: () => 0, random: () => 0 },
      ),
    ).rejects.toMatchObject({ details: { category: 'server' } })
    expect(calls).toBe(3) // 1 initial + 2 retries
  })

  it('respects Retry-After for the backoff wait', async () => {
    let calls = 0
    await expect(
      withRetries(
        async () => {
          calls++
          if (calls === 1) throw providerError('rate_limited', 0) // 0s retry-after
          return 'ok'
        },
        { policy: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 2 }, random: () => 0 },
      ),
    ).resolves.toMatchObject({ result: 'ok', attempts: 2 })
  })

  it('stops retrying when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    let calls = 0
    await expect(
      withRetries(
        async () => {
          calls++
          throw providerError('server')
        },
        { policy: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2 }, signal: controller.signal, now: () => 0, random: () => 0 },
      ),
    ).rejects.toMatchObject({ details: { category: 'server' } })
    expect(calls).toBe(1)
  })

  it('bounds retries by the total deadline budget', async () => {
    let nowMs = 0
    let calls = 0
    await expect(
      withRetries(
        async () => {
          calls++
          nowMs += 1000 // simulate 1s passing per attempt
          throw providerError('server')
        },
        { policy: { maxAttempts: 5, baseDelayMs: 1, maxDelayMs: 2 }, now: () => nowMs, random: () => 0, deadlineMs: 2000 },
      ),
    ).rejects.toMatchObject({ details: { category: 'timeout' } })
    // Attempt 1 at t=0 (0 elapsed), attempt 2 at t=1000, attempt 3 at t=2000 →
    // now()-started = 2000, not > 2000 so it proceeds; attempt 4
    // would be t=3000 > 2000 → budget exceeded. So 3 attempts run.
    expect(calls).toBe(3)
  })
})
