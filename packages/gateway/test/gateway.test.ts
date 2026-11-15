import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startGatewayServer, type GatewayConfig } from '../src/index.js'

interface RequestRecord {
  url: string
  body: Record<string, unknown>
}

function createMockUpstream(
  behavior: (request: IncomingMessage, body: Record<string, unknown>, response: ServerResponse) => void,
): { server: Server; url: string; records: RequestRecord[] } {
  const records: RequestRecord[] = []
  const server = createServer((request, response) => {
    void (async () => {
      let raw = ''
      for await (const chunk of request) raw += String(chunk)
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
      records.push({ url: request.url ?? '/', body })
      behavior(request, body, response)
    })().catch((error: unknown) => {
      response.writeHead(500, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: String(error) }))
    })
  })
  return { server, url: '', records }
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve(typeof address === 'object' && address !== null ? address.port : 0)
    })
  })
}

async function readSse(response: globalThis.Response): Promise<string> {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let text = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    text += decoder.decode(value, { stream: true })
  }
  return text
}

const OPENAI_CHAT_RESPONSE = {
  id: 'resp_gateway',
  model: 'gpt-4o-mini',
  choices: [
    {
      index: 0,
      message: { role: 'assistant', content: 'hello from backend' },
      finish_reason: 'stop',
    },
  ],
  usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
}

const OPENAI_TOOL_RESPONSE = {
  id: 'resp_tool',
  model: 'gpt-4o-mini',
  choices: [
    {
      index: 0,
      message: {
        role: 'assistant',
        content: 'let me check',
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } },
        ],
      },
      finish_reason: 'tool_calls',
    },
  ],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
}

describe('polyllm gateway (prototype)', () => {
  let upstreamA: ReturnType<typeof createMockUpstream>
  let upstreamB: ReturnType<typeof createMockUpstream>
  let portA: number
  let portB: number
  let gatewayPort: number
  let closeGateway: () => Promise<void>

  beforeAll(async () => {
    upstreamA = createMockUpstream((_request, body, response) => {
      const firstContent = (body.messages as Array<{ content?: unknown }> | undefined)?.[0]?.content
      if (firstContent === 'failover please') {
        response.writeHead(429, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { message: 'rate limited' } }))
        return
      }
      if (body.stream === true) {
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        const events = [
          { id: 's1', model: 'gpt-4o-mini', choices: [{ index: 0, delta: { role: 'assistant', content: 'He' } }] },
          { id: 's1', model: 'gpt-4o-mini', choices: [{ index: 0, delta: { content: 'llo' } }] },
          { id: 's1', model: 'gpt-4o-mini', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
        ]
        for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`)
        response.write('data: [DONE]\n\n')
        response.end()
        return
      }
      if (JSON.stringify(body).includes('"weather?"')) {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify(OPENAI_TOOL_RESPONSE))
        return
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(OPENAI_CHAT_RESPONSE))
    })
    portA = await listen(upstreamA.server)

    upstreamB = createMockUpstream((_request, _body, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          id: 'resp_failover',
          model: 'deepseek-chat',
          choices: [{ index: 0, message: { role: 'assistant', content: 'recovered' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      )
    })
    portB = await listen(upstreamB.server)

    const config: GatewayConfig = {
      providers: {
        openai: { baseUrl: `http://127.0.0.1:${portA}/v1`, apiKey: 'test-a' },
        deepseek: { baseUrl: `http://127.0.0.1:${portB}/v1`, apiKey: 'test-b' },
      },
      plugins: ['openai', 'deepseek'],
      routes: [{ match: 'claude-sonnet-4-5', target: 'openai:gpt-4o-mini' }],
      groups: [
        { name: 'resilient', models: ['openai:gpt-4o-mini', 'deepseek:deepseek-chat'] },
      ],
      allowUnlistedModels: true,
    }
    const { server, port } = await startGatewayServer({ ...config, port: 0 })
    gatewayPort = port
    closeGateway = async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  afterAll(async () => {
    await closeGateway()
    upstreamA.server.close()
    upstreamB.server.close()
  })

  it('serves /v1/models from the registry', async () => {
    const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/models`)
    const body = (await response.json()) as { data: { id: string }[] }
    const ids = body.data.map((model) => model.id)
    expect(ids).toContain('openai:gpt-4o-mini')
    expect(ids).toContain('deepseek:deepseek-chat')
  })

  it('passes OpenAI chat completions through (non-stream)', async () => {
    const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'openai:gpt-4o-mini',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    })
    const body = (await response.json()) as Record<string, unknown>
    expect(body.id).toBe('resp_gateway')
    const choice = (body.choices as Array<{ message: { content: string }; finish_reason: string }>)[0]
    expect(choice.message.content).toBe('hello from backend')
    expect(choice.finish_reason).toBe('stop')
    expect((body.usage as { total_tokens: number }).total_tokens).toBe(20)
  })

  it('streams OpenAI chunks and terminates with [DONE]', async () => {
    const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'openai:gpt-4o-mini',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      }),
    })
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    const text = await readSse(response)
    expect(text).toContain('"content":"He"')
    expect(text).toContain('"content":"llo"')
    expect(text).toContain('"finish_reason":"stop"')
    expect(text.trimEnd().endsWith('data: [DONE]')).toBe(true)
  })

  it('translates Anthropic Messages requests to OpenAI and renders Anthropic responses (the magpie bridge)', async () => {
    const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 1024,
        system: 'Be terse.',
        tools: [
          { name: 'get_weather', description: 'd', input_schema: { type: 'object', properties: { city: { type: 'string' } } } },
        ],
        messages: [
          { role: 'user', content: 'weather?' },
          { role: 'assistant', content: [{ type: 'tool_use', id: 'call_9', name: 'get_weather', input: { city: 'Paris' } }] },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_9', content: '{"temp":20}' }] },
          { role: 'user', content: 'now summarize' },
        ],
      }) as string,
    })
    expect(response.ok).toBe(true)

    // The backend must have received an OpenAI-format request.
    const upstreamRequest = upstreamA.records.at(-1)!.body
    const messages = upstreamRequest.messages as Array<Record<string, unknown>>
    expect(messages[0]).toMatchObject({ role: 'system', content: 'Be terse.' })
    expect(messages.some((m) => m.role === 'tool' && m.tool_call_id === 'call_9')).toBe(true)
    const tools = upstreamRequest.tools as Array<{ function: { name: string; parameters: unknown } }>
    expect(tools[0].function.name).toBe('get_weather')
    expect(tools[0].function.parameters).toMatchObject({ type: 'object' })

    // And the response must be Anthropic-format.
    const body = (await response.json()) as Record<string, unknown>
    const content = body.content as Array<{ type: string; text?: string; name?: string; input?: Record<string, unknown> }>
    expect(content.some((block) => block.type === 'text' && block.text === 'let me check')).toBe(true)
    const toolUse = content.find((block) => block.type === 'tool_use')
    expect(toolUse).toMatchObject({ id: 'call_1', name: 'get_weather' })
    expect(toolUse!.input).toEqual({ city: 'Paris' })
    expect(body.stop_reason).toBe('tool_use')
    expect(body.usage).toEqual({ input_tokens: 10, output_tokens: 5 })
  })

  it('streams Anthropic SSE events (message_start → deltas → message_delta → message_stop)', async () => {
    const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      }),
    })
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    const text = await readSse(response)
    const eventNames = [...text.matchAll(/event: (.+)/g)].map((match) => match[1])
    expect(eventNames[0]).toBe('message_start')
    expect(eventNames).toContain('content_block_delta')
    expect(eventNames[eventNames.length - 1]).toBe('message_stop')
    expect(text).toContain('"text":"He"')
    expect(text).toContain('"stop_reason":"end_turn"')
  })

  it('fails over across a routing group and annotates the switch', async () => {
    const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'group:resilient',
        messages: [{ role: 'user', content: 'failover please' }],
      }),
    })
    const body = (await response.json()) as Record<string, unknown>
    expect(body.id).toBe('resp_failover')
    const failoverHeader = response.headers.get('x-polyllm-failover') ?? ''
    expect(failoverHeader).toContain('openai:gpt-4o-mini')
    expect(failoverHeader).toContain('deepseek:deepseek-chat')
  })

  it('rejects undefined routing groups with 404', async () => {
    const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'group:missing', messages: [{ role: 'user', content: 'hi' }] }),
    })
    expect(response.status).toBe(404)
  })
})
