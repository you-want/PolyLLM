//! Zero-key live demo: mock upstream + gateway, exercises every magpie-parity
//! feature end to end. Run: `pnpm --filter @you-want/polyllm-gateway build && node scripts/demo.mjs`

import { createServer } from 'node:http'
import { startGatewayServer } from '../dist/index.js'

const seen = []
const upstream = createServer((request, response) => {
  void (async () => {
    let raw = ''
    for await (const chunk of request) raw += String(chunk)
    const body = raw ? JSON.parse(raw) : {}
    seen.push({ auth: (request.headers.authorization ?? '').slice(-12), body })
    if ((request.headers.authorization ?? '').endsWith('demo-key-1')) {
      response.writeHead(429, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'quota exhausted (demo)' } }))
      return
    }
    const placeholder = raw.match(/::POLYLLM_MASK_\d+::/)?.[0]
    if (body.stream === true) {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const events = [
        { id: 'demostream', model: body.model ?? 'demo', choices: [{ index: 0, delta: { role: 'assistant', content: 'streaming ' } }] },
        { id: 'demostream', model: body.model ?? 'demo', choices: [{ index: 0, delta: { content: 'demo ok' } }] },
        { id: 'demostream', model: body.model ?? 'demo', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      ]
      for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`)
      response.write('data: [DONE]\n\n')
      response.end()
      return
    }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(
      JSON.stringify({
        id: 'demoresp',
        model: body.model ?? 'demo',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: placeholder ?? `demo ok (${body.model ?? ''})` },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      }),
    )
  })().catch(() => response.end())
})
await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
const upstreamPort = upstream.address().port

const { server, port } = await startGatewayServer({
  providers: {
    openai: {
      baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
      accounts: ['sk-demo-key-1', 'sk-demo-key-2'],
    },
  },
  plugins: ['openai'],
  routes: [{ match: 'claude-sonnet-4-5', target: 'openai:gpt-4o-mini' }],
  groups: [{ name: 'resilient', models: ['openai:gpt-4o-mini'] }],
  masking: { enabled: true },
  port: 0,
})
const base = `http://127.0.0.1:${port}`
console.log(`\n🚪 gateway ready at ${base}\n`)

async function post(path, body) {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: response.status, headers: response.headers, body: await response.json() }
}

console.log('① OpenAI 透传（非流式）')
const openai = await post('/v1/chat/completions', {
  model: 'openai:gpt-4o-mini',
  messages: [{ role: 'user', content: 'hi' }],
})
console.log(`   ${openai.status} id=${openai.body.id} content="${openai.body.choices?.[0]?.message?.content}"\n`)

console.log('② Anthropic → OpenAI 桥接（/v1/messages，Claude Code 的协议）')
const anthropic = await post('/v1/messages', {
  model: 'claude-sonnet-4-5',
  max_tokens: 64,
  system: 'Be terse.',
  messages: [{ role: 'user', content: 'hello' }],
})
console.log(`   ${anthropic.status} stop_reason=${anthropic.body.stop_reason} content="${anthropic.body.content?.[0]?.text}"`)
console.log('   ↑ 请求经路由 claude-sonnet-4-5 → openai:gpt-4o-mini\n')

console.log('③ 故障转移组（demo-key-1 配额耗尽 → 自动切 demo-key-2）')
const failover = await post('/v1/chat/completions', {
  model: 'group:resilient',
  messages: [{ role: 'user', content: 'hi' }],
})
console.log(`   ${failover.status} id=${failover.body.id}`)
console.log(`   x-polyllm-failover: ${failover.headers.get('x-polyllm-failover')}\n`)

console.log('④ 隐私脱敏（邮箱/密钥出站前掩码，入站还原）')
const masked = await post('/v1/chat/completions', {
  model: 'openai:gpt-4o-mini',
  messages: [{ role: 'user', content: 'my key sk-abcdef1234567890abcdef, mail dev@example.com' }],
})
console.log(`   ${masked.status} content="${masked.body.choices?.[0]?.message?.content}"`)
console.log(`   上游实际收到: ${JSON.stringify(seen.at(-1).body.messages?.[0]?.content)}\n`)

console.log('⑤ 用量看板（GET /usage，每账号计数）')
const usage = await fetch(`${base}/usage`).then((r) => r.json())
console.log(`   ${JSON.stringify(usage)}\n`)

console.log('⑥ Anthropic 流式（SSE 事件序列）')
const stream = await fetch(`${base}/v1/messages`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'hi' }] }),
})
const text = await stream.text()
const events = [...text.matchAll(/event: (.+)/g)].map((m) => m[1])
console.log(`   ${stream.status} 事件序列: ${events.join(' → ')}`)
if (events.length === 0) console.log('   RAW:', JSON.stringify(text.slice(0, 300)))

server.close()
upstream.close()
console.log('demo done — 所有流量均走本地 mock 上游，无真实密钥。')
