import { describe, expect, it } from 'vitest'
import {
  classifyFetchError,
  classifyHttpStatus,
  extractErrorExcerpt,
  extractRequestId,
  isRetryableCategory,
  maskSensitive,
  parseRetryAfter,
  providerTransportError,
} from '../src/errors.js'

describe('classifyHttpStatus', () => {
  it('maps 401/403/429/400/422/5xx to the correct categories', () => {
    expect(classifyHttpStatus(401)).toBe('auth')
    expect(classifyHttpStatus(403)).toBe('permission')
    expect(classifyHttpStatus(429)).toBe('rate_limited')
    expect(classifyHttpStatus(400)).toBe('invalid_request')
    expect(classifyHttpStatus(422)).toBe('invalid_request')
    expect(classifyHttpStatus(500)).toBe('server')
    expect(classifyHttpStatus(503)).toBe('server')
    expect(classifyHttpStatus(599)).toBe('server')
    expect(classifyHttpStatus(418)).toBe('unknown')
  })

  it('falls back to the provided category for unmapped statuses', () => {
    expect(classifyHttpStatus(418, 'connection')).toBe('connection')
  })
})

describe('isRetryableCategory', () => {
  it('marks only rate_limited, server, and connection as retryable', () => {
    expect(isRetryableCategory('rate_limited')).toBe(true)
    expect(isRetryableCategory('server')).toBe(true)
    expect(isRetryableCategory('connection')).toBe(true)
    expect(isRetryableCategory('auth')).toBe(false)
    expect(isRetryableCategory('permission')).toBe(false)
    expect(isRetryableCategory('invalid_request')).toBe(false)
    expect(isRetryableCategory('parse')).toBe(false)
    expect(isRetryableCategory('timeout')).toBe(false)
    expect(isRetryableCategory('cancelled')).toBe(false)
    expect(isRetryableCategory('unknown')).toBe(false)
  })
})

describe('classifyFetchError', () => {
  it('maps TimeoutError DOMException to timeout', () => {
    const err = new DOMException('Timeout', 'TimeoutError')
    expect(classifyFetchError(err, false)).toBe('timeout')
  })

  it('maps AbortError with hasTimeout=true to timeout, false to cancelled', () => {
    const err = new DOMException('Aborted', 'AbortError')
    expect(classifyFetchError(err, true)).toBe('timeout')
    expect(classifyFetchError(err, false)).toBe('cancelled')
  })

  it('maps unknown errors to connection', () => {
    expect(classifyFetchError(new TypeError('fetch failed'), false)).toBe('connection')
    expect(classifyFetchError(new Error('DNS failure'), false)).toBe('connection')
  })
})

describe('parseRetryAfter', () => {
  it('parses delta-seconds', () => {
    expect(parseRetryAfter('5')).toBe(5)
    expect(parseRetryAfter('0')).toBe(0)
  })

  it('parses HTTP-date (future)', () => {
    const now = Date.now()
    const future = new Date(now + 30_000).toUTCString()
    const result = parseRetryAfter(future, now)
    // toUTCString() truncates to the nearest minute, so allow up to 1s drift
    expect(result).toBeGreaterThan(29)
    expect(result).toBeLessThan(31)
  })

  it('returns undefined for absent or unparseable values', () => {
    expect(parseRetryAfter(null)).toBeUndefined()
    expect(parseRetryAfter(undefined)).toBeUndefined()
    expect(parseRetryAfter('')).toBeUndefined()
    expect(parseRetryAfter('not-a-number')).toBeUndefined()
  })
})

describe('extractRequestId', () => {
  it('prefers request-id header', () => {
    const headers = { get: (name: string) => (name === 'request-id' ? 'req-abc' : null) }
    expect(extractRequestId(headers, null)).toBe('req-abc')
  })

  it('falls back to x-request-id then x-response-id', () => {
    const headers = { get: (name: string) => (name === 'x-request-id' ? 'req-xyz' : null) }
    expect(extractRequestId(headers, null)).toBe('req-xyz')
  })

  it('falls back to body.request_id / body.requestId / body.id', () => {
    expect(extractRequestId(null, { request_id: 'req-body-1' })).toBe('req-body-1')
    expect(extractRequestId(null, { requestId: 'req-body-2' })).toBe('req-body-2')
    expect(extractRequestId(null, { id: 'req-body-3' })).toBe('req-body-3')
  })

  it('returns undefined when nothing is present', () => {
    expect(extractRequestId(null, null)).toBeUndefined()
    expect(extractRequestId(null, {})).toBeUndefined()
  })
})

describe('maskSensitive', () => {
  it('masks sk- style keys', () => {
    const masked = maskSensitive('key is sk-abcdef123456789')
    expect(masked).not.toContain('abcdef123456789')
    expect(masked).toContain('sk-***')
  })

  it('masks Bearer tokens', () => {
    const masked = maskSensitive('Authorization: Bearer sk-abc123secret')
    expect(masked).not.toContain('abc123secret')
  })

  it('does not alter plain text without credentials', () => {
    const text = 'Rate limit exceeded, retry later'
    expect(maskSensitive(text)).toBe(text)
  })
})

describe('extractErrorExcerpt', () => {
  it('extracts error.message from a nested error object', () => {
    const body = { error: { message: 'invalid api key', code: 'auth' } }
    expect(extractErrorExcerpt(body)).toBe('invalid api key')
  })

  it('extracts top-level message string', () => {
    expect(extractErrorExcerpt({ message: 'quota exceeded' })).toBe('quota exceeded')
  })

  it('masks credentials in the excerpt', () => {
    const body = { message: 'Bearer sk-secret1234567890' }
    const excerpt = extractErrorExcerpt(body)
    expect(excerpt).not.toContain('sk-secret1234567890')
    expect(excerpt).toContain('***')
  })

  it('truncates long strings', () => {
    const long = 'x'.repeat(300)
    const excerpt = extractErrorExcerpt(long, 50)
    expect(excerpt.length).toBeLessThanOrEqual(51)
    expect(excerpt).toContain('…')
  })

  it('handles string input directly', () => {
    expect(extractErrorExcerpt('plain error')).toBe('plain error')
  })

  it('handles null/undefined gracefully', () => {
    expect(extractErrorExcerpt(null)).toBe('null')
  })
})

describe('providerTransportError', () => {
  it('builds correct details for a timeout', () => {
    const err = new DOMException('Timeout', 'TimeoutError')
    const error = providerTransportError('openai', err, 'OpenAI API 调用', true, 5000)
    expect(error.code).toBe('PROVIDER_ERROR')
    expect(error.details?.category).toBe('timeout')
    expect(error.details?.retryable).toBe(false)
    expect(error.details?.timeoutMs).toBe(5000)
  })

  it('builds correct details for a user cancellation without timeout', () => {
    const err = new DOMException('Aborted', 'AbortError')
    const error = providerTransportError('anthropic', err, 'Anthropic API 调用', false)
    expect(error.details?.category).toBe('cancelled')
    expect(error.details?.retryable).toBe(false)
  })

  it('builds correct details for a network connection failure', () => {
    const err = new TypeError('fetch failed')
    const error = providerTransportError('gemini', err, 'Gemini API 调用', false)
    expect(error.details?.category).toBe('connection')
    expect(error.details?.retryable).toBe(true)
  })
})
