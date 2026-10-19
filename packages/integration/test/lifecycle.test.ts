import { afterEach, describe, expect, it, vi } from 'vitest'
import { createLLM, type LLMPlugin } from '@you-want/polyllm-core'
import { openAIPlugin } from '@you-want/polyllm-openai'
import { deepSeekPlugin } from '@you-want/polyllm-deepseek'
import { anthropicPlugin } from '@you-want/polyllm-anthropic'
import { geminiPlugin } from '@you-want/polyllm-gemini'
import { ollamaPlugin } from '@you-want/polyllm-ollama'
import { openAICompatiblePlugin } from '@you-want/polyllm-openai-compatible'

const plugins = [openAIPlugin, deepSeekPlugin, anthropicPlugin, geminiPlugin, ollamaPlugin, openAICompatiblePlugin]
const request = { messages: [{ role: 'user' as const, content: 'hi' }] }
const config = { apiKey: 'RuntimeCredential1234', baseUrl: 'https://fixture.invalid/v1', headers: { 'x-custom-token': 'PrivateHeader1234' } }
function setup(plugin: LLMPlugin) {
  const llm = createLLM({ plugins: [plugin], providers: { [plugin.provider]: config }, allowUnlistedModels: true })
  return { llm, model: `${plugin.provider}:${plugin.models[0]?.id ?? 'dynamic'}` }
}
function event(plugin: LLMPlugin) {
  if (plugin.provider === 'anthropic') return { type: 'content_block_delta', delta: { type: 'text_delta', text: 'first' }, index: 0 }
  if (plugin.provider === 'gemini') return { candidates: [{ content: { parts: [{ text: 'first' }] } }] }
  return { id: 'r', choices: [{ delta: { content: 'first' } }] }
}
afterEach(() => vi.unstubAllGlobals())

for (const plugin of plugins) describe(`${plugin.provider} lifecycle`, () => {
  it('masks runtime credentials in HTTP bodies and request IDs and preserves Retry-After', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('RuntimeCredential1234 PrivateHeader1234', { status: 429, headers: { 'x-request-id': 'RuntimeCredential1234', 'retry-after': '60' } })))
    const { llm, model } = setup(plugin)
    try { await llm.chat(model, request); expect.fail('must fail') } catch (error: any) {
      expect(error.details).toMatchObject({ category: 'rate_limited', retryable: true, requestId: '***', retryAfterSeconds: 60 })
      expect(JSON.stringify(error) + error.message).not.toContain(config.apiKey)
      expect(error.message).not.toContain('PrivateHeader1234')
    }
  })
  it('classifies malformed successful responses as parse failures', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not JSON')))
    const { llm, model } = setup(plugin)
    await expect(llm.chat(model, request)).rejects.toMatchObject({ code: 'PROVIDER_ERROR', details: { category: 'parse', retryable: false } })
  })
  it('closes and unlocks the stream when the caller stops early', async () => {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event(plugin))}\n\n`)) }, cancel() { cancelled = true } })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body)))
    const { llm, model } = setup(plugin)
    for await (const chunk of llm.chatStream(model, request)) { expect(chunk.delta.content).toBe('first'); break }
    expect(cancelled).toBe(true)
    expect(body.locked).toBe(false)
  })
  it('classifies broken stream JSON and releases its reader', async () => {
    const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode('data: {bad}\n\n')); c.close() } })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body)))
    const { llm, model } = setup(plugin)
    await expect((async () => { for await (const _ of llm.chatStream(model, request)) { /* drain */ } })()).rejects.toMatchObject({ details: { category: 'parse' } })
    expect(body.locked).toBe(false)
  })
  it('bounds in-flight retries by a single total deadline', async () => {
    let calls = 0
    const signals: AbortSignal[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      signals.push(init.signal)
      calls++
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 45)
        init.signal.addEventListener('abort', () => { clearTimeout(timer); reject(init.signal.reason) }, { once: true })
      })
      return new Response('temporary', { status: 503 })
    }))
    const { llm, model } = setup(plugin)
    await expect(llm.chat(model, request, { timeoutMs: 70, retries: { maxAttempts: 3, baseDelayMs: 0 } })).rejects.toMatchObject({ details: { category: 'timeout' } })
    expect(calls).toBe(2)
    expect(signals[0]).toBe(signals[1])
    expect(signals[1].aborted).toBe(true)
  })
  it('recognizes a custom user abort reason', async () => {
    const controller = new AbortController()
    vi.stubGlobal('fetch', vi.fn(async () => { controller.abort(new Error('custom reason')); throw controller.signal.reason }))
    const { llm, model } = setup(plugin)
    await expect(llm.chat(model, request, { signal: controller.signal })).rejects.toMatchObject({ details: { category: 'cancelled', retryable: false } })
  })
})

it('never replays a stream after a visible chunk', async () => {
  const fetchMock = vi.fn(async () => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"first"}}]}\n\n'))
    setTimeout(() => controller.error(new Error('connection reset')), 0)
  } })))
  vi.stubGlobal('fetch', fetchMock)
  const { llm, model } = setup(openAIPlugin)
  const seen: string[] = []
  await expect((async () => { for await (const chunk of llm.chatStream(model, request, { retries: { maxAttempts: 3, baseDelayMs: 0 } })) seen.push(chunk.delta.content ?? '') })()).rejects.toMatchObject({ details: { category: 'connection' } })
  expect(seen).toEqual(['first'])
  expect(fetchMock).toHaveBeenCalledTimes(1)
})

it('keeps DeepSeek tool indexes across interleaved argument fragments', async () => {
  const events = [
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'a', type: 'function', function: { name: 'echo', arguments: '{"text":"' } }, { index: 1, id: 'b', type: 'function', function: { name: 'echo', arguments: '{"text":"' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: 'second"}' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'first"}' } }] } }] },
  ]
  vi.stubGlobal('fetch', vi.fn(async () => new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n')))
  const { llm, model } = setup(deepSeekPlugin)
  const args: Record<number, string> = {}
  for await (const chunk of llm.chatStream(model, request)) for (const call of chunk.delta.toolCalls ?? []) args[call.index!] = (args[call.index!] ?? '') + (call.function?.arguments ?? '')
  expect(JSON.parse(args[0])).toEqual({ text: 'first' })
  expect(JSON.parse(args[1])).toEqual({ text: 'second' })
})

it('maps a plain Gemini tool result using the preceding tool call name', async () => {
  let body: any
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => { body = JSON.parse(init.body); return Response.json({ candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] }) }))
  const { llm, model } = setup(geminiPlugin)
  await llm.chat(model, { messages: [
    { role: 'assistant', content: '', toolCalls: [{ id: 'call_a', type: 'function', function: { name: 'weather', arguments: '{}' } }] },
    { role: 'tool', content: 'sunny', toolCallId: 'call_a' },
  ] })
  expect(body.contents[1].parts[0].functionResponse).toEqual({ name: 'weather', response: { result: 'sunny' } })
})

for (const plugin of plugins) it(`${plugin.provider} times out while waiting for more stream data and releases the reader`, async () => {
  let cancelled = false
  const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event(plugin))}\n\n`)) }, cancel() { cancelled = true } })
  vi.stubGlobal('fetch', vi.fn(async () => new Response(body)))
  const { llm, model } = setup(plugin)
  let count = 0
  await expect((async () => { for await (const _chunk of llm.chatStream(model, request, { timeoutMs: 30 })) count++ })()).rejects.toMatchObject({ details: { category: 'timeout' } })
  expect(count).toBe(1)
  expect(cancelled).toBe(true)
  expect(body.locked).toBe(false)
})

it('closes an Anthropic stream immediately at message_stop', async () => {
  let cancelled = false
  const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode('data: {"type":"message_stop"}\n\n')) }, cancel() { cancelled = true } })
  vi.stubGlobal('fetch', vi.fn(async () => new Response(body)))
  const { llm, model } = setup(anthropicPlugin)
  for await (const _ of llm.chatStream(model, request)) { /* no more events required */ }
  expect(cancelled).toBe(true)
  expect(body.locked).toBe(false)
})
