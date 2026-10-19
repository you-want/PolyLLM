import { PolyLLMError, providerError, providerHttpError, providerTransportError } from './errors.js'
import { validateRetryPolicy, withRetries } from './retry.js'
import type { ChatContext } from './types.js'

/** A single deadline covers headers, body, backoff and every retry. */
function lifecycle(context: Partial<ChatContext>) {
  validateRetryPolicy(context.retries)
  if (context.timeoutMs !== undefined && (!Number.isSafeInteger(context.timeoutMs) || context.timeoutMs <= 0)) throw new PolyLLMError('INVALID_CONFIG', 'timeoutMs 必须是正整数（毫秒）')
  const controller = new AbortController()
  const timeoutController = new AbortController()
  const timer = context.timeoutMs === undefined ? undefined : setTimeout(() => timeoutController.abort(new DOMException('Timeout', 'TimeoutError')), context.timeoutMs)
  const timeout = context.timeoutMs === undefined ? undefined : timeoutController.signal
  const signals = [controller.signal, context.signal, timeout].filter((s): s is AbortSignal => !!s)
  return { timeout, signal: AbortSignal.any(signals), close() { clearTimeout(timer); controller.abort() } }
}

function secrets(init: RequestInit): string[] {
  const values: string[] = []
  new Headers(init.headers).forEach((value, key) => {
    if (/auth|key|token|secret|cookie|credential|password|session/i.test(key)) {
      values.push(value, value.replace(/^Bearer\s+/i, ''))
    }
  })
  return values
}

function failure(provider: string, error: unknown, context: Partial<ChatContext>, timeout?: AbortSignal) {
  if (error instanceof PolyLLMError) return error
  if (context.signal?.aborted || timeout?.aborted) {
    return providerTransportError(provider, error, provider, context.signal, context.timeoutMs, timeout)
  }
  if (error instanceof SyntaxError || error instanceof TypeError && /encoded data/.test(error.message)) {
    return providerError(provider, undefined, 'parse', `${provider}: 响应解析失败`)
  }
  return providerTransportError(provider, error, provider, context.signal, context.timeoutMs, timeout)
}

async function checkedFetch(provider: string, url: string, init: RequestInit, signal: AbortSignal, knownSecrets: readonly string[] = []): Promise<Response> {
  const response = await fetch(url, { ...init, signal })
  if (!response.ok) {
    // Status takes precedence even if reading the diagnostic body fails.
    let text = ''
    try { text = await response.text() } catch { /* retain HTTP classification */ }
    throw providerHttpError(provider, response.status, response.headers, text, provider, [...secrets(init), ...knownSecrets])
  }
  return response
}

export async function providerJSON<T>(
  provider: string, url: string, init: RequestInit,
  context: Partial<ChatContext>, parse: (data: Record<string, unknown>) => T, knownSecrets: readonly string[] = [],
): Promise<T> {
  const life = lifecycle(context)
  try {
    const { result } = await withRetries(async () => {
      try {
        const response = await checkedFetch(provider, url, init, life.signal, knownSecrets)
        let data: unknown
        try { data = await response.json() }
        catch (error) {
          if (error instanceof SyntaxError) throw providerError(provider, response.status, 'parse', `${provider}: 响应解析失败`)
          throw error
        }
        try {
          if (!data || typeof data !== 'object' || Array.isArray(data)) throw new SyntaxError('Expected object')
          return parse(data as Record<string, unknown>)
        } catch (error) {
          if (error instanceof PolyLLMError) throw error
          throw providerError(provider, response.status, 'parse', `${provider}: 响应解析失败`)
        }
      } catch (error) { throw failure(provider, error, context, life.timeout) }
    }, { policy: context.retries, signal: life.signal, deadlineMs: context.timeoutMs })
    return result
  } catch (error) { throw failure(provider, error, context, life.timeout) }
  finally { life.close() }
}

/** Incremental UTF-8 framing. SSE joins data fields; NDJSON uses one JSON per line. */
export async function* readJSONEvents(body: ReadableStream<Uint8Array>, wire = 'text/event-stream', signal?: AbortSignal): AsyncGenerator<Record<string, unknown>> {
  const reader = body.getReader()
  const onAbort = () => { void reader.cancel().catch(() => {}) }
  signal?.addEventListener('abort', onAbort, { once: true })
  if (signal?.aborted) onAbort()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let buffer = ''
  let data: string[] = []
  let sawField = false
  const ndjson = wire.includes('ndjson')
  function payload(line: string): string | undefined {
    if (ndjson) return line.trim() || undefined
    if (line === '') {
      const value = data.length ? data.join('\n') : undefined
      data = []
      return value
    }
    if (line.startsWith('data:')) { data.push(line.slice(5).replace(/^ /, '')); sawField = true }
    else if (/^(?:event|id|retry):|^:/.test(line)) sawField = true
    else if (line.trim()) throw new SyntaxError('Invalid SSE field')
    return undefined
  }
  function decode(value: string): Record<string, unknown> {
    const event: unknown = JSON.parse(value)
    if (!event || typeof event !== 'object' || Array.isArray(event)) throw new SyntaxError('Expected JSON event object')
    return event as Record<string, unknown>
  }
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (signal?.aborted) throw signal.reason
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true })
      let end: number
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end).replace(/\r$/, '')
        buffer = buffer.slice(end + 1)
        const value = payload(line)
        if (value === '[DONE]') return
        if (value) yield decode(value)
      }
      if (done) break
    }
    if (buffer) {
      const value = payload(buffer.replace(/\r$/, ''))
      if (value === '[DONE]') return
      if (value) yield decode(value)
    }
    if (!ndjson && data.length) {
      const value = data.join('\n')
      if (value === '[DONE]') return
      if (value) yield decode(value)
    }
    if (!ndjson && !sawField) throw new SyntaxError('Empty SSE response')
  } finally {
    try { await reader.cancel() } catch { /* preserve the original failure */ }
    reader.releaseLock()
    signal?.removeEventListener('abort', onAbort)
  }
}

/** Retry only before the first visible chunk, never replay a partial answer. */
export async function* providerStream<T>(
  provider: string, url: string, init: RequestInit, context: ChatContext,
  parse: (event: Record<string, unknown>) => T[], knownSecrets: readonly string[] = [],
  isEnd: (event: Record<string, unknown>) => boolean = () => false,
): AsyncGenerator<T> {
  const life = lifecycle(context)
  let events: AsyncGenerator<Record<string, unknown>> | undefined
  let first: T[] = []
  let ended = false
  const parseEvent = (event: Record<string, unknown>): T[] => {
    try {
      if (event.error) throw providerHttpError(provider, typeof event.status === 'number' ? event.status : 500, null, event, provider, [...secrets(init), ...knownSecrets])
      return parse(event)
    }
    catch (error) {
      if (error instanceof PolyLLMError) throw error
      throw providerError(provider, undefined, 'parse', `${provider}: 流事件解析失败`)
    }
  }
  try {
    await withRetries(async () => {
      try {
        const response = await checkedFetch(provider, url, init, life.signal, knownSecrets)
        if (!response.body) throw providerError(provider, undefined, 'connection', `${provider}: 未返回响应流`)
        events = readJSONEvents(response.body, response.headers.get('content-type') ?? undefined, life.signal)
        while (true) {
          const next = await events.next()
          if (next.done) return
          first = parseEvent(next.value)
          ended = isEnd(next.value)
          if (first.length || ended) return
        }
      } catch (error) {
        await events?.return(undefined)
        throw failure(provider, error, context, life.timeout)
      }
    }, { policy: context.retries, signal: life.signal, deadlineMs: context.timeoutMs })
    for (const chunk of first) yield chunk
    if (ended) return
    if (events) for await (const event of events) {
      for (const chunk of parseEvent(event)) yield chunk
      if (isEnd(event)) return
    }
  } catch (error) { throw failure(provider, error, context, life.timeout) }
  finally {
    life.close()
    await events?.return(undefined)
  }
}
