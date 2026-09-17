import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createLLM } from '@you-want/polyllm-core'
import { openAICompatiblePlugin } from '@you-want/polyllm-openai-compatible'

const server = createServer(async (request, response) => {
  assert.equal(request.headers.authorization, 'Bearer smoke-key')
  if (request.url === '/v1/models' && request.method === 'GET') {
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ data: [{ id: 'demo-model', owned_by: 'smoke' }] }))
    return
  }

  if (request.url !== '/v1/chat/completions' || request.method !== 'POST') {
    response.writeHead(404)
    response.end()
    return
  }

  let body = ''
  for await (const chunk of request) body += chunk
  const payload = JSON.parse(body)
  assert.equal(payload.model, 'demo-model')
  assert.equal(payload.messages[0].content, 'smoke test')

  response.setHeader('content-type', payload.stream ? 'text/event-stream' : 'application/json')
  if (payload.stream) {
    response.write(`data: ${JSON.stringify({ id: 'stream-1', model: 'demo-model', choices: [{ index: 0, delta: { content: 'stream ok' }, finish_reason: null }] })}\n\n`)
    response.write(`data: ${JSON.stringify({ id: 'stream-1', model: 'demo-model', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`)
    response.end('data: [DONE]\n\n')
    return
  }

  response.end(JSON.stringify({
    id: 'response-1',
    model: 'demo-model',
    choices: [{ index: 0, message: { role: 'assistant', content: 'chat ok' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
  }))
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const { port } = server.address()
const config = { apiKey: 'smoke-key', baseUrl: `http://127.0.0.1:${port}/v1` }

try {
  const models = await openAICompatiblePlugin.listModels(config)
  assert.deepEqual(models.map((item) => item.id), ['demo-model'])

  const llm = createLLM({
    plugins: [openAICompatiblePlugin],
    providers: { 'openai-compatible': config },
    allowUnlistedModels: true,
    paramPolicy: 'strict',
  })
  const response = await llm.chat('openai-compatible:demo-model', {
    messages: [{ role: 'user', content: 'smoke test' }],
  })
  assert.equal(response.choices[0]?.message.content, 'chat ok')

  let streamed = ''
  for await (const chunk of llm.chatStream('openai-compatible:demo-model', {
    messages: [{ role: 'user', content: 'smoke test' }],
  })) streamed += chunk.delta.content ?? ''
  assert.equal(streamed, 'stream ok')
  console.log('published npm packages: smoke ok')
} finally {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
}
