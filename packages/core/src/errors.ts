export type ErrorCode =
  | 'AMBIGUOUS_MODEL'
  | 'INVALID_CONFIG'
  | 'DUPLICATE_MODEL'
  | 'DUPLICATE_PROVIDER'
  | 'MISSING_PROVIDER_CONFIG'
  | 'MISSING_API_KEY'
  | 'PROVIDER_ERROR'
  | 'UNKNOWN_MODEL'
  | 'UNSUPPORTED_PARAMETER'

export class PolyLLMError extends Error {
  readonly code: ErrorCode
  readonly details?: Record<string, unknown> | undefined

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message)
    this.name = 'PolyLLMError'
    this.code = code
    this.details = details
  }
}

export class UnknownModelError extends PolyLLMError {
  constructor(input: string, availableModels: readonly string[]) {
    super('UNKNOWN_MODEL', `未知模型: ${input}。可用模型: ${availableModels.join(', ')}`, {
      input,
      availableModels,
    })
  }
}

export class AmbiguousModelError extends PolyLLMError {
  constructor(input: string, candidates: readonly string[]) {
    super('AMBIGUOUS_MODEL', `模型标识有歧义: ${input}。请使用 provider:model，候选: ${candidates.join(', ')}`, {
      input,
      candidates,
    })
  }
}

/**
 * Machine-readable classification of provider/transport failures.
 * See docs/protocol.md §7 for the mapping rules.
 */
export type ErrorCategory =
  | 'auth'
  | 'permission'
  | 'rate_limited'
  | 'invalid_request'
  | 'server'
  | 'connection'
  | 'parse'
  | 'timeout'
  | 'cancelled'
  | 'unknown'

/**
 * Diagnostic detail fields attached to `PROVIDER_ERROR` (and to transport/parse
 * failures) per docs/protocol.md §7. The stable `code` value is unchanged;
 * finer-grained classification is expressed through these optional fields.
 */
export interface ProviderErrorDetails {
  provider: string
  status?: number
  category: ErrorCategory
  retryable: boolean
  requestId?: string
  retryAfterSeconds?: number
}

const RETRYABLE_CATEGORIES: readonly ErrorCategory[] = ['rate_limited', 'server', 'connection']

/**
 * Determine the error category for an HTTP status.
 * 401 -> auth, 403 -> permission, 429 -> rate_limited,
 * 400/422 -> invalid_request, 5xx -> server, else `fallback`.
 */
export function classifyHttpStatus(status: number, fallback: ErrorCategory = 'unknown'): ErrorCategory {
  if (status === 401) return 'auth'
  if (status === 403) return 'permission'
  if (status === 429) return 'rate_limited'
  if (status === 400 || status === 422) return 'invalid_request'
  if (status >= 500 && status <= 599) return 'server'
  return fallback
}

/** Whether a category is safe for the built-in retry policy to retry. */
export function isRetryableCategory(category: ErrorCategory): boolean {
  return RETRYABLE_CATEGORIES.includes(category)
}

/**
 * Build `PROVIDER_ERROR` details that carry the §7 diagnostic fields while
 * keeping `status` and any pre-0.4.0 keys already passed in `extra` for
 * backward compatibility.
 */
export function buildProviderErrorDetails(
  provider: string,
  status: number | undefined,
  category: ErrorCategory,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const details: Record<string, unknown> = { ...extra, provider, category, retryable: isRetryableCategory(category) }
  if (status !== undefined) details.status = status
  return details
}

/**
 * Parse a Retry-After header value (delta-seconds or HTTP-date) into seconds.
 * Returns `undefined` when the header is absent or unparseable.
 */
export function parseRetryAfter(
  headerValue: string | null | undefined,
  nowMs: number = Date.now(),
): number | undefined {
  if (!headerValue) return undefined
  const trimmed = headerValue.trim()
  if (trimmed === '') return undefined
  const asSeconds = Number(trimmed)
  if (Number.isFinite(asSeconds)) return asSeconds >= 0 ? asSeconds : undefined
  const asDate = Date.parse(trimmed)
  if (!Number.isNaN(asDate)) {
    return Math.max(0, (asDate - nowMs) / 1000)
  }
  return undefined
}

/**
 * Extract a provider request id from response headers or a parsed error body.
 * Checks `request-id` / `x-request-id` / `x-response-id` headers, then a JSON
 * body's `request_id` / `requestId` / `id` key. Returns `undefined` when none
 * are present.
 */
export function extractRequestId(
  headers: { get?: (name: string) => string | null } | null | undefined,
  body: Record<string, unknown> | null | undefined,
): string | undefined {
  const fromHeader = (name: string): string | undefined => {
    const value = headers?.get?.(name)
    return value ? value : undefined
  }
  const headerValue = fromHeader('request-id') ?? fromHeader('x-request-id') ?? fromHeader('x-response-id')
  if (headerValue) return headerValue
  if (!body) return undefined
  const candidate =
    (body.request_id as string | undefined) ?? (body.requestId as string | undefined) ?? (body.id as string | undefined)
  return typeof candidate === 'string' && candidate ? candidate : undefined
}

/**
 * Mask credential-looking substrings so error messages and details never leak
 * keys, Bearer tokens, or URL query credentials.
 *
 * Patterns covered (docs/protocol.md §7.2):
 *  - `sk-...` style provider keys
 *  - `Authorization: <value>` headers (both the header form and the bare Bearer form)
 *  - `Bearer <token>`
 *  - URL query values for well-known credential keys
 *    (`key`, `api_key`, `apikey`, `token`, `access_token`, `secret`,
 *    `client_secret`, `session`) — a provider error that echoes the request
 *    URL will no longer leak `?key=...` or `?token=...`.
 */
export function maskSensitive(text: string, knownSecrets: readonly string[] = []): string {
  let masked = text
  // sk-style keys first so that a bare key (not in a Bearer/Authorization
  // context) is masked even when no header or Bearer prefix is present.
  masked = masked.replace(/\bsk-[A-Za-z0-9_-]{8,}/g, 'sk-***')
  // Authorization header form. The value may be "Bearer TOKEN" (two words) or
  // a bare token; match up to a comma/semicolon/quote that terminates a
  // JSON string or CSV list — NOT a space, so the full two-word value is
  // masked in one pass.
  masked = masked.replace(/\bAuthorization:\s*(Bearer\s+)?[A-Za-z0-9._~+/=-]+/gi, 'Authorization: ***')
  // Bare Bearer tokens not preceded by an Authorization header.
  masked = masked.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer ***')
  // URL query credential values (?key=..., &token=..., ?api_key=...).
  masked = masked.replace(
    /([?&](?:key|api_key|apikey|token|access_token|secret|client_secret|session)=)[^&\s"']+/gi,
    '$1***',
  )
  // Any explicitly provided runtime secret (the live API key for this call) is
  // masked even when it does not match the `sk-`/`Bearer` shapes above.
  for (const secret of knownSecrets) {
    if (!secret) continue
    masked = masked.split(secret).join('***')
  }
  return masked
}

/**
 * Extract a short, human-readable error excerpt from a provider error body.
 * Prefers `error.message` / `message` / string `error`, falls back to a
 * JSON-serialized snippet. The result is always masked via `maskSensitive`
 * and truncated to `maxLength` characters so unfiltered bodies never reach
 * the caller's log or error message (docs/protocol.md §7.2).
 */
export function extractErrorExcerpt(
  body: unknown,
  maxLength: number = 200,
  knownSecrets: readonly string[] = [],
): string {
  let raw: string
  if (typeof body === 'string') {
    raw = body
  } else if (body && typeof body === 'object') {
    const record = body as Record<string, unknown>
    const errorField = record.error
    if (
      errorField &&
      typeof errorField === 'object' &&
      typeof (errorField as Record<string, unknown>).message === 'string'
    ) {
      raw = (errorField as Record<string, unknown>).message as string
    } else if (typeof record.message === 'string') {
      raw = record.message
    } else if (typeof errorField === 'string') {
      raw = errorField
    } else {
      raw = JSON.stringify(body)
    }
  } else {
    raw = String(body)
  }
  const masked = maskSensitive(raw, knownSecrets)
  return masked.length > maxLength ? masked.slice(0, maxLength) + '…' : masked
}

/**
 * Create a `PolyLLMError` for a failed fetch call with the full §7
 * diagnostic fields.
 */
export function providerError(
  provider: string,
  status: number | undefined,
  category: ErrorCategory,
  message: string,
  extra: Record<string, unknown> = {},
): PolyLLMError {
  const details = buildProviderErrorDetails(provider, status, category, extra)
  return new PolyLLMError('PROVIDER_ERROR', message, details)
}

/**
 * Create a `PolyLLMError` for an HTTP response failure. Reads `Retry-After`
 * from headers and extracts the request id and a masked error excerpt from the
 * body, producing the full §7 diagnostic set.
 */
export function providerHttpError(
  provider: string,
  status: number,
  headers: { get?: (name: string) => string | null } | null,
  body: Record<string, unknown> | string | null,
  label: string,
  knownSecrets: readonly string[] = [],
): PolyLLMError {
  const category = classifyHttpStatus(status)
  const parsedBody = typeof body === 'string' ? tryParseJson(body) : body
  const requestId = extractRequestId(headers, parsedBody ?? null)
  const retryAfterSeconds = parseRetryAfter(headers?.get?.('retry-after') ?? null)
  const excerpt = extractErrorExcerpt(parsedBody ?? body ?? '', 200, knownSecrets)
  const extra: Record<string, unknown> = { label }
  if (requestId !== undefined) extra.requestId = maskSensitive(requestId, knownSecrets)
  if (retryAfterSeconds !== undefined) extra.retryAfterSeconds = retryAfterSeconds
  return providerError(provider, status, category, `${label}: ${status} ${excerpt}`, extra)
}

/**
 * Classify a `fetch` rejection into an `ErrorCategory`.
 *
 * - `TimeoutError` DOMException -> `timeout`
 * - `AbortError` where the **user-provided** signal (not the timeout signal)
 *   is the one that fired -> `cancelled`
 * - `AbortError` where only a `timeoutMs` was set and its derived timeout
 *   signal fired -> `timeout`
 * - anything else (network/DNS/socket) -> `connection`
 *
 * `userSignal` is the caller's `AbortSignal` (may be undefined) and
 * `timeoutSignal` is the signal derived from `timeoutMs`.
 */
export function classifyFetchError(
  error: unknown,
  userSignal: AbortSignal | undefined,
  timeoutSignal: AbortSignal | undefined,
): ErrorCategory {
  if (userSignal?.aborted) return 'cancelled'
  if (timeoutSignal?.aborted) return 'timeout'
  if (error instanceof DOMException) {
    if (error.name === 'TimeoutError') return 'timeout'
    if (error.name === 'AbortError') {
      const userFired = userSignal?.aborted === true
      const timeoutFired = timeoutSignal?.aborted === true
      if (timeoutFired && !userFired) return 'timeout'
      if (userFired) return 'cancelled'
      // Neither fired but we still got an AbortError: a user cancel is the
      // safer default (a user cancel is never retried).
      return timeoutSignal ? 'timeout' : 'cancelled'
    }
  }
  return 'connection'
}

function describeFetchFailure(category: ErrorCategory, label: string, timeoutMs?: number): string {
  if (category === 'timeout') return `${label}: 请求在 ${timeoutMs}ms 预算内未完成`
  if (category === 'cancelled') return `${label}: 调用方在请求完成前取消`
  return `${label}: 连接失败`
}

/**
 * Build a `PROVIDER_ERROR` for a `fetch` rejection (no HTTP status available).
 * `userSignal` / `timeoutSignal` let the classifier tell a user cancel apart
 * from a timeout when both are in play.
 */
export function providerTransportError(
  provider: string,
  error: unknown,
  label: string,
  userSignal: AbortSignal | undefined,
  timeoutMs?: number,
  timeoutSignal?: AbortSignal | undefined,
): PolyLLMError {
  const category = classifyFetchError(error, userSignal, timeoutSignal)
  const details: Record<string, unknown> = {
    provider,
    category,
    retryable: isRetryableCategory(category),
    label,
  }
  if (timeoutMs !== undefined && category === 'timeout') details.timeoutMs = timeoutMs
  return new PolyLLMError('PROVIDER_ERROR', describeFetchFailure(category, label, timeoutMs), details)
}

function tryParseJson(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}
