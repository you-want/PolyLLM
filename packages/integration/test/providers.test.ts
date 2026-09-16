import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createLLM, type LLMPlugin, type ProviderConfig } from '@you-want/polyllm-core'
import { anthropicPlugin } from '@you-want/polyllm-anthropic'
import { deepSeekPlugin } from '@you-want/polyllm-deepseek'
import { openAICompatiblePlugin } from '@you-want/polyllm-openai-compatible'
import { openAIPlugin } from '@you-want/polyllm-openai'

const plugins: Record<string, LLMPlugin> = {
  openai: openAIPlugin,
  deepseek: deepSeekPlugin,
  anthropic: anthropicPlugin,
  'openai-compatible': openAICompatiblePlugin,
}

const providerCases = [
  { provider: 'openai', model: 'gpt-4o-mini' },
  { provider: 'deepseek', model: 'deepseek-chat' },
  { provider: 'anthropic', model: 'claude-sonnet-4-5' },
  { provider: 'openai-compatible', model: 'custom-model' },
] as const

interface RequestRecord {
  url: string
  headers: IncomingMessage['headers']
  body: Record<string, unknown>
}

let server: ReturnType<typeof createServer>
let serverUrl = ''
const requestRecords: RequestRecord[] = []

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  let body = ''
  for await (const chunk of request) body += chunk.toString()
  return body ? JSON.parse(body) as Record<string, unknown> : {}
}

function sendJson(response: ServerResponse, body: unknown, status = 200): void {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

function sendSse(response: ServerResponse, events: unknown[], done = true): void {
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`)
  if (done) response.write('data: [DONE]\n\n')
  response.end()
}

async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = request.url ?? '/'
  if (request.headers['x-force-error'] === 'true') {
    sendJson(response, { error: { message: 'rate limited' } }, 429)
    return
  }
  if (url.includes('/slow/')) {
    setTimeout(() => sendJson(response, { id: 'slow' }), 200)
    return
  }

  if (url.endsWith('/models')) {
    requestRecords.push({ url, headers: request.headers, body: {} })
    sendJson(response, { data: [{ id: 'mock-model', owned_by: 'integration' }] })
    return
  }

  if (!url.endsWith('/chat/completions') && !url.endsWith('/messages')) {
    sendJson(response, { error: 'not found' }, 404)
    return
  }

  const body = await readBody(request)
  requestRecords.push({ url, headers: request.headers, body })
  const isAnthropic = url.endsWith('/messages')
  const isStream = body.stream === true
  if (isStream) {
    if (isAnthropic) {
      sendSse(response, [
        { type: 'message_start', message: { id: 'msg-integration', model: 'mock-anthropic', usage: { input_tokens: 2 } } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
      ])
    } else {
      sendSse(response, [
        { id: 'chatcmpl-integration', model: 'mock-model', choices: [{ delta: { role: 'assistant', content: 'hello' } }] },
        { id: 'chatcmpl-integration', model: 'mock-model', choices: [{ delta: {}, finish_reason: 'stop' }] },
      ])
    }
    return
  }

  if (isAnthropic) {
    sendJson(response, {
      id: 'msg-integration',
      model: 'mock-anthropic',
      content: [{ type: 'text', text: 'hello' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 2, output_tokens: 1 },
    })
    return
  }

  sendJson(response, {
    id: 'chatcmpl-integration',
    model: 'mock-model',
    choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
  })
}

beforeAll(async () => {
  server = createServer((request, response) => {
    void handleRequest(request, response).catch((error: unknown) => sendJson(response, { error: String(error) }, 500))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('集成测试服务启动失败')
  serverUrl = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
})

describe('provider HTTP integration', () => {
  it.each(providerCases)('$provider supports discovery, chat and streaming', async ({ provider, model }) => {
    const plugin = plugins[provider]
    const config: ProviderConfig = {
      apiKey: 'integration-key',
      baseUrl: `${serverUrl}${provider === 'openai-compatible' ? '' : '/v1'}`,
      headers: { 'x-integration-test': 'true' },
    }
    const discovered = await plugin.listModels?.(config)
    expect(discovered?.[0]?.id).toBe('mock-model')

    const llm = createLLM({
      plugins: [plugin],
      providers: { [provider]: config },
      allowUnlistedModels: provider === 'openai-compatible',
    })
    const response = await llm.chat(`${provider}:${model}`, {
      messages: [{ role: 'user', content: 'hello' }],
    })
    expect(response.choices[0]?.message.content).toBe('hello')

    const chunks = []
    for await (const chunk of llm.chatStream(`${provider}:${model}`, {
      messages: [{ role: 'user', content: 'hello' }],
    })) chunks.push(chunk)
    expect(chunks.some((chunk) => chunk.delta.content === 'hello')).toBe(true)
  })

  it('passes an explicit API key and custom header to the provider', async () => {
    requestRecords.length = 0
    const config: ProviderConfig = { apiKey: 'header-key', baseUrl: `${serverUrl}/v1`, headers: { 'x-custom': 'yes' } }
    await openAIPlugin.listModels?.(config)
    expect(requestRecords.at(-1)?.headers.authorization).toBe('Bearer header-key')
    expect(requestRecords.at(-1)?.headers['x-custom']).toBe('yes')
  })

  it('maps vision and tool requests at the HTTP boundary', async () => {
    requestRecords.length = 0
    const openai = createLLM({
      plugins: [openAIPlugin],
      providers: { openai: { apiKey: 'integration-key', baseUrl: `${serverUrl}/v1` } },
    })
    await openai.chat('openai:gpt-4o-mini', {
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'describe' },
          { type: 'image_url', imageUrl: { url: 'https://example.com/image.png', detail: 'low' } },
        ],
      }],
      tools: [{
        type: 'function',
        function: { name: 'lookup', description: 'Lookup data', parameters: { type: 'object' } },
      }],
    })
    const openAIRequest = requestRecords.at(-1)?.body
    expect(openAIRequest?.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'describe' },
          { type: 'image_url', image_url: { url: 'https://example.com/image.png', detail: 'low' } },
        ],
      },
    ])
    expect(openAIRequest?.tools).toEqual([
      { type: 'function', function: { name: 'lookup', description: 'Lookup data', parameters: { type: 'object' } } },
    ])

    const anthropic = createLLM({
      plugins: [anthropicPlugin],
      providers: { anthropic: { apiKey: 'integration-key', baseUrl: `${serverUrl}/v1` } },
    })
    await anthropic.chat('anthropic:claude-sonnet-4-5', {
      messages: [
        { role: 'system', content: 'Be concise' },
        { role: 'user', content: [{ type: 'image_url', imageUrl: { url: 'https://example.com/image.png' } }] },
      ],
      tools: [{
        type: 'function',
        function: { name: 'lookup', description: 'Lookup data', parameters: { type: 'object' } },
      }],
    })
    const anthropicRequest = requestRecords.at(-1)?.body
    expect(anthropicRequest?.system).toBe('Be concise')
    expect(anthropicRequest?.messages).toEqual([
      { role: 'user', content: [{ type: 'image', source: { type: 'url', url: 'https://example.com/image.png' } }] },
    ])
    expect(anthropicRequest?.tools).toEqual([
      { name: 'lookup', description: 'Lookup data', input_schema: { type: 'object' } },
    ])
  })

  it('normalizes provider HTTP errors', async () => {
    const promise = openAIPlugin.listModels?.({
      apiKey: 'integration-key',
      baseUrl: `${serverUrl}/v1`,
      headers: { 'x-force-error': 'true' },
    })
    await expect(promise).rejects.toMatchObject({
      code: 'PROVIDER_ERROR',
      details: { provider: 'openai', status: 429 },
    })
  })

  it('honors timeout and caller cancellation', async () => {
    const config: ProviderConfig = { apiKey: 'integration-key', baseUrl: `${serverUrl}/slow/v1` }
    const context = { model: openAIPlugin.models[0]!, timeoutMs: 20 }
    await expect(openAIPlugin.chat({ model: context.model.id, messages: [{ role: 'user', content: 'hello' }] }, config, context)).rejects.toThrow()

    const controller = new AbortController()
    controller.abort()
    await expect(openAIPlugin.chat(
      { model: context.model.id, messages: [{ role: 'user', content: 'hello' }] },
      config,
      { model: context.model, signal: controller.signal },
    )).rejects.toThrow()
  })
})
