import { PolyLLMError, isRetryableCategory } from './errors.js'
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
 * A positive `retryAfterSeconds` (a valid provider `Retry-After`) is a hard
 * floor that wins over the exponential backoff and is NOT capped by
 * `maxDelayMs` — waiting longer than the cap is correct when the provider
 * told us to; the total budget then decides whether the retry still fits.
 * Only the synthetic exponential backoff is capped.
 * Jitter is a random fraction in `[0, jitter]` of the computed base delay.
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

  if (retryAfterSeconds !== undefined && retryAfterSeconds > 0) {
    return retryAfterSeconds * 1000
  }
  // Exponential: base * factor^(attempt-1). First retry (attempt=1) -> base.
  let delay = base * Math.pow(factor, attempt - 1)
  delay += delay * jitterRatio * random()
  return Math.min(delay, maxDelay)
}

/**
 * The total number of attempts the policy allows (initial + retries).
 */
export function maxAttempts(policy: RetryPolicy | undefined): number {
  validateRetryPolicy(policy)
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
      reject(retryAbortError(signal))
      return
    }
    // Do NOT unref the timer: a top-level await during a retry must keep the
    // Node event loop (and therefore the process) alive until the next attempt
    // (P1 #13). An unref'd timer lets the process exit with an unsettled
    // pending retry.
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(retryAbortError(signal))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
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
    policy?: RetryPolicy | undefined
    signal?: AbortSignal | undefined
    /** Injectable clock/random for deterministic tests. */
    random?: () => number
    /** Read current time in ms. Defaults to `performance.now`. */
    now?: () => number
    /** Total time budget in ms (from `timeoutMs`). Bounded retries. */
    deadlineMs?: number | undefined
  } = {},
): Promise<{ result: T; attempts: number; outcome: AttemptOutcome }> {
  const { policy, signal, random = Math.random, now = () => performance.now(), deadlineMs } = options
  const limit = policy ? maxAttempts(policy) : 1
  const started = now()

  for (let attempt = 1; ; attempt++) {
    if (deadlineMs !== undefined && now() - started >= deadlineMs) {
      // Budget exhausted before this attempt: surface as a timeout, no retry.
      throw new PolyLLMError('PROVIDER_ERROR', '重试预算耗尽', {
        category: 'timeout' as ErrorCategory,
        retryable: false,
        retried: attempt > 1,
      })
    }
    try {
      if (signal?.aborted) throw retryAbortError(signal)
      const remaining = deadlineMs === undefined ? undefined : deadlineMs - (now() - started)
      const result = await boundedOperation(() => operation(attempt), remaining, signal)
      return { result, attempts: attempt, outcome: attempt > 1 ? 'retried' : 'succeeded' }
    } catch (error) {
      const category = error instanceof PolyLLMError ? error.details?.category as ErrorCategory | undefined : undefined
      const last = attempt >= limit || !policy
      if (!last && category !== undefined && isRetryableErrorCategory(category) && !signal?.aborted) {
        const retryAfterSeconds = (error as PolyLLMError).details?.retryAfterSeconds as number | undefined
        const delayMs = computeBackoffMs(policy, retryAfterSeconds, attempt, random)
        if (deadlineMs !== undefined) {
          const remaining = deadlineMs - (now() - started)
          if (remaining <= 0 || delayMs >= remaining) {
            throw new PolyLLMError('PROVIDER_ERROR', '重试预算耗尽', {
              category: 'timeout' as ErrorCategory,
              retryable: false,
              retried: attempt > 1,
            })
          }
        }
        if (delayMs > 0) await sleep(delayMs, signal)
        continue
      }
      throw error
    }
  }
}

function retryAbortError(signal?: AbortSignal): PolyLLMError {
  return new PolyLLMError('PROVIDER_ERROR', '请求已终止', {
    category: signal?.reason?.name === 'TimeoutError' ? 'timeout' : 'cancelled', retryable: false,
  })
}

async function boundedOperation<T>(operation: () => Promise<T>, remaining?: number, signal?: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_, reject) => {
        if (remaining !== undefined) timer = setTimeout(() => reject(new PolyLLMError('PROVIDER_ERROR', '请求预算耗尽', { category: 'timeout', retryable: false })), remaining)
        onAbort = () => reject(retryAbortError(signal))
        signal?.addEventListener('abort', onAbort, { once: true })
        if (signal?.aborted) onAbort()
      }),
    ])
  } finally {
    clearTimeout(timer)
    if (onAbort) signal?.removeEventListener('abort', onAbort)
  }
}

export function validateRetryPolicy(policy?: RetryPolicy): void {
  if (policy === undefined) return
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) throw new PolyLLMError('INVALID_CONFIG', 'retries 必须是策略对象')
  for (const [key, value] of Object.entries(policy)) {
    if (!['maxAttempts', 'baseDelayMs', 'backoffFactor', 'maxDelayMs', 'jitter'].includes(key) || typeof value !== 'number' || !Number.isFinite(value) || value < 0 || key === 'maxAttempts' && !Number.isInteger(value) || key === 'backoffFactor' && value === 0 || key === 'jitter' && value > 1) {
      throw new PolyLLMError('INVALID_CONFIG', `无效的重试配置: ${key}`, { parameter: key })
    }
  }
}
