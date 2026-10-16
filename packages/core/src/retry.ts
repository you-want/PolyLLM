import { PolyLLMError, classifyHttpStatus, isRetryableCategory } from './errors.js'
import type { ErrorCategory } from './errors.js'
import type { RetryPolicy } from './types.js'

/**
 * Retry strategy. Defaults when omitted from `RetryPolicy`:
 * up to 2 retries (3 total attempts), exponential backoff base 500ms,
 * factor 2, jitter 0.25, capped at 8000ms.
 */
export const DEFAULT_RETRY_MAX_ATTEMPTS = 2
export const DEFAULT_RETRY_BASE_DELAY_MS = 500
export const DEFAULT_RETRY_BACKOFF_FACTOR = 2
export const DEFAULT_RETRY_MAX_DELAY_MS = 8000
export const DEFAULT_RETRY_JITTER = 0.25

export interface RetryContext {
  /** 0-based index of the retry about to be performed (first retry = 1). */
  attempt: number
  /** The error category of the last failed attempt. */
  category: ErrorCategory
  /** Parsed `Retry-After` seconds from the last response, if present. */
  retryAfterSeconds?: number | undefined
  /** Milliseconds already elapsed within the total budget. */
  elapsedMs: number
}

/**
 * Whether an error of the given category should be retried at all.
 * Only transient categories are eligible; auth/permission/invalid_request/
 * parse/timeout/cancelled/unknown are never retried.
 */
export function isRetryableErrorCategory(category: ErrorCategory): boolean {
  return isRetryableCategory(category)
}

/**
 * Compute the backoff delay for a given retry attempt.
 *
 * `retryAfterSeconds`, when provided and positive, wins over the exponential
 * backoff (a well-behaved provider telling us exactly how long to wait).
 * Jitter is a random fraction in `[0, jitter]` of the computed base delay.
 * The result is capped by `maxDelayMs`.
 */
export function computeBackoffMs(
  policy: RetryPolicy | undefined,
  retryAfterSeconds: number | undefined,
  attempt: number,
  random: () => number = Math.random,
): number {
  const base = policy?.baseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS
  const factor = policy?.backoffFactor ?? DEFAULT_RETRY_BACKOFF_FACTOR
  const jitterRatio = policy?.jitter ?? DEFAULT_RETRY_JITTER
  const maxDelay = policy?.maxDelayMs ?? DEFAULT_RETRY_MAX_DELAY_MS

  let delay: number
  if (retryAfterSeconds !== undefined && retryAfterSeconds > 0) {
    delay = retryAfterSeconds * 1000
  } else {
    // Exponential: base * factor^(attempt-1). First retry (attempt=1) -> base.
    delay = base * Math.pow(factor, attempt - 1)
    const jitter = delay * jitterRatio * random()
    delay += jitter
  }
  return Math.min(delay, maxDelay)
}

/**
 * The total number of attempts the policy allows (initial + retries).
 */
export function maxAttempts(policy: RetryPolicy | undefined): number {
  return (policy?.maxAttempts ?? DEFAULT_RETRY_MAX_ATTEMPTS) + 1
}

/**
 * A cancellable sleep that rejects with a `PROVIDER_ERROR` (cancelled) if
 * `signal` aborts during the wait.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(cancelledRetryError('重试等待前已被取消'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(cancelledRetryError('重试等待期间被取消'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    ;(timer as { unref?: () => void }).unref?.()
  })
}

function cancelledRetryError(message: string): PolyLLMError {
  return new PolyLLMError('PROVIDER_ERROR', message, {
    category: 'cancelled' as ErrorCategory,
    retryable: false,
    retried: true,
  })
}

export type AttemptOutcome = 'succeeded' | 'retried' | 'exhausted'

/**
 * Run an async operation with the retry policy.
 *
 * - Retries only when the rejected error is a `PolyLLMError` whose
 *   `details.category` is retryable (rate_limited / server / connection).
 * - Respects `details.retryAfterSeconds` when present.
 * - Stops early when `signal` aborts (classified `cancelled`).
 * - Returns the number of attempts actually made.
 *
 * This is the single retry layer; plugins must not add their own retry on top.
 */
export async function withRetries<T>(
  operation: (attempt: number) => Promise<T>,
  options: {
    policy?: RetryPolicy
    signal?: AbortSignal | undefined
    /** Injectable clock/random for deterministic tests. */
    random?: () => number
    /** Read current time in ms. Defaults to `Date.now`. */
    now?: () => number
    /** Total time budget in ms (from `timeoutMs`). Bounded retries. */
    deadlineMs?: number | undefined
  } = {},
): Promise<{ result: T; attempts: number; outcome: AttemptOutcome }> {
  const { policy, signal, random = Math.random, now = () => Date.now(), deadlineMs } = options
  const limit = policy ? maxAttempts(policy) : 1
  const started = now()

  for (let attempt = 1; ; attempt++) {
    if (deadlineMs !== undefined && now() - started > deadlineMs) {
      // Budget exhausted before this attempt: surface as a timeout, no retry.
      throw new PolyLLMError('PROVIDER_ERROR', '重试预算耗尽', {
        category: 'timeout' as ErrorCategory,
        retryable: false,
        retried: attempt > 1,
      })
    }
    try {
      const result = await operation(attempt)
      return { result, attempts: attempt, outcome: attempt > 1 ? 'retried' : 'succeeded' }
    } catch (error) {
      const category = (error as PolyLLMError).details?.category as ErrorCategory | undefined
      const last = attempt >= limit || !policy
      if (!last && category !== undefined && isRetryableErrorCategory(category) && !signal?.aborted) {
        const retryAfterSeconds = (error as PolyLLMError).details?.retryAfterSeconds as number | undefined
        const delayMs = computeBackoffMs(policy, retryAfterSeconds, attempt, random)
        await sleep(delayMs, signal)
        continue
      }
      throw error
    }
  }
}
