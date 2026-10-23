/** Actual SDK fixture runner + Draft 2020-12 validation + strict cross-language diff. */
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import Ajv2020 from 'ajv/dist/2020.js'
import { createLLM } from '../packages/core/dist/index.js'
import { openAIPlugin } from '../packages/openai/dist/index.js'
import { geminiPlugin } from '../packages/gemini/dist/index.js'
import { openAICompatiblePlugin } from '../packages/openai-compatible/dist/index.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const fixtureDir = resolve(process.env.POLYLLM_PROTOCOL_FIXTURES ?? resolve(ROOT, 'fixtures/protocol'))
const outDir = resolve(process.env.POLYLLM_PROTOCOL_OUTPUT ?? resolve(ROOT, '.verify-protocol'))
mkdirSync(outDir, { recursive: true })
const cases = readdirSync(fixtureDir).filter(f => f.endsWith('.json')).sort().flatMap(f => JSON.parse(readFileSync(resolve(fixtureDir, f), 'utf8')).cases)
const ajv = new Ajv2020({ strict: false, allErrors: true })
for (const file of readdirSync(resolve(ROOT, 'schemas')).filter(f => f.endsWith('.json'))) ajv.addSchema(JSON.parse(readFileSync(resolve(ROOT, 'schemas', file), 'utf8')))
const schemas = { request: 'unified-request.json', response: 'unified-response.json', chunks: 'unified-stream-chunk.json' }
function validate(field, value) {
  const validator = ajv.getSchema(`polyllm/0.4.0/schemas/${schemas[field]}`)
  if (!validator) throw new Error(`Missing schema: ${field}`)
  return validator(value)
}
const keys = { tool_calls: 'toolCalls', tool_call_id: 'toolCallId', image_url: 'imageUrl', finish_reason: 'finishReason', provider_metadata: 'providerMetadata', prompt_tokens: 'promptTokens', completion_tokens: 'completionTokens', total_tokens: 'totalTokens', function_calling: 'functionCalling', json_mode: 'jsonMode', system_prompt: 'systemPrompt' }
function canonical(value, key = '') {
  if (value === null || value === undefined) return undefined
  if (Array.isArray(value)) return value.map(v => canonical(v))
  if (typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) {
      const name = keys[k] ?? k
      if (['toolCalls', 'tool_calls'].includes(k) && Array.isArray(v) && !v.length) continue
      const mapped = ['wire', 'parameters', 'providerMetadata', 'provider_metadata'].includes(k) ? JSON.parse(JSON.stringify(v)) : canonical(v, name)
      if (mapped !== undefined && mapped !== null) out[name] = mapped
    }
    return out
  }
  return value
}
function responseProjection(response) {
  const r = canonical(response)
  const unavailable = r.providerMetadata?.usageUnavailable
  delete r.providerMetadata
  if (unavailable) r.providerMetadata = { usageUnavailable: true }
  return r
}
function streamProjection(chunks) { return canonical(chunks).map(c => { delete c.providerMetadata; return c }) }

async function execute(c) {
  let wire
  const original = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    wire = init?.body ? JSON.parse(init.body) : undefined
    const trigger = c.trigger ?? {}
    if (trigger.kind === 'connection-failure') throw new TypeError('connection')
    if (trigger.kind === 'timeout') throw new DOMException('timeout', 'TimeoutError')
    if (trigger.kind === 'cancelled') throw new DOMException('cancelled', 'AbortError')
    if (trigger.kind === 'invalid-json-parse') return new Response('INVALID JSON')
    if (trigger.kind === 'http') return new Response('<html>failure</html>', { status: trigger.status })
    if (c.raw !== undefined || c.sourceEvents) {
      const bytes = new TextEncoder().encode(c.raw ?? c.sourceEvents.map(e => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n')
      let offset = 0
      return new Response(new ReadableStream({ pull(controller) {
        if (offset === bytes.length) { controller.close(); return }
        controller.enqueue(bytes.slice(offset, offset += 1))
      } }), { headers: { 'content-type': c.wire ?? 'text/event-stream' } })
    }
    return Response.json(c.source ?? { id: 'resp', model: 'gpt-4o-mini', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } })
  }
  const custom = { ...openAICompatiblePlugin, provider: 'custom-gateway', createModelSpec(id) { return { ...openAICompatiblePlugin.createModelSpec(id), provider: 'custom-gateway' } } }
  const plugins = [openAIPlugin, geminiPlugin, custom]
  const needsUnlisted = c.id === 'dynamic-model-conservative-capabilities' || c.id === 'capability-refusal-vision-on-non-vision-model' || c.id.startsWith('policy-')
  const llm = createLLM({ plugins, providers: Object.fromEntries(plugins.map(p => [p.provider, { apiKey: 'fixture-key', baseUrl: 'https://fixture.invalid/v1' }])), allowUnlistedModels: needsUnlisted, paramPolicy: c.paramPolicy ?? 'strict' })
  try {
    if (c.request) {
      const { model, ...payload } = c.request
      await llm.chat(model, payload)
      const spec = llm.getModelInfo(model)
      return { wire, resolvedId: `${spec.provider}:${spec.id}`, capabilities: spec.capabilities }
    }
    if (c.raw !== undefined || c.sourceEvents) {
      const chunks = []
      for await (const chunk of llm.chatStream('openai:gpt-4o-mini', { messages: [{ role: 'user', content: 'hi' }] })) chunks.push(chunk)
      return { chunks }
    }
    return { response: await llm.chat('openai:gpt-4o-mini', { messages: [{ role: 'user', content: 'hi' }] }) }
  } catch (error) {
    if (error.code !== 'PROVIDER_ERROR' && !['UNKNOWN_MODEL', 'UNSUPPORTED_PARAMETER'].includes(error.code)) throw error
    const details = Object.fromEntries(Object.entries(error.details ?? {}).filter(([k]) => ['category', 'retryable', 'parameter', 'status'].includes(k)))
    return { error: { code: error.code, ...details } }
  } finally { globalThis.fetch = original }
}

function check(c, actual) {
  if (actual.rejected) { assert.equal(c.valid, false, c.id); return actual }
  if (c.error) {
    assert.ok(actual.error, `${c.id}: expected failure`)
    for (const [k, v] of Object.entries(c.error)) assert.deepEqual(actual.error[k], v, `${c.id}: error.${k}`)
  } else assert.equal(actual.error?.category, undefined, `${c.id}: unexpected error ${JSON.stringify(actual.error)}`)
  if (c.response) assert.deepEqual(responseProjection(actual.response), c.response, `${c.id}: parsed response`)
  if (c.chunks) assert.deepEqual(streamProjection(actual.chunks), c.chunks, `${c.id}: parsed chunks`)
  if (c.raw !== undefined && !c.error) {
    const chunks = streamProjection(actual.chunks)
    for (const chunk of chunks) assert.ok(validate('chunks', chunk), `${c.id}: invalid runtime chunk`)
    assert.deepEqual(chunks.map(({ delta, finishReason, usage }) => ({ delta, ...(finishReason === undefined ? {} : { finishReason }), ...(usage === undefined ? {} : { usage }) })), c.expectedChunks, `${c.id}: raw framing`)
  }
  const e = c.expectations ?? {}
  const wire = actual.wire ?? {}
  const response = actual.response ? responseProjection(actual.response) : undefined
  const chunks = actual.chunks ? streamProjection(actual.chunks) : undefined
  const calls = response?.choices[0].message.toolCalls ?? chunks?.flatMap(x => x.delta.toolCalls ?? []) ?? []
  const observations = {
    messagesCount: wire.messages?.length,
    userContentParts: wire.messages?.find(m => m.role === 'user')?.content?.length,
    toolMessageHasToolCallId: wire.messages?.some(m => m.role === 'tool' && !!m.tool_call_id),
    toolCount: wire.tools?.length ?? 0, toolName: wire.tools?.[0]?.function?.name,
    hasToolResult: wire.messages?.some(m => m.role === 'tool' && !!m.tool_call_id),
    responseFormat: wire.response_format?.type ?? null,
    resolvedId: actual.resolvedId,
    vision: actual.capabilities?.vision, functionCalling: actual.capabilities?.functionCalling, jsonMode: actual.capabilities?.jsonMode,
    rejects: !!actual.error, code: actual.error?.code,
    capability: actual.error?.parameter === 'messages[content=image_url]' ? 'vision' : actual.error?.parameter,
    stage: actual.error?.code === 'UNKNOWN_MODEL' ? 'registry' : undefined,
    usageTotal: response?.usage.totalTokens,
    finishReason: response?.choices[0].finishReason ?? chunks?.at(-1)?.finishReason,
    providerMetadata: response?.providerMetadata ?? null,
    toolCallCount: calls.length, argumentsParseOk: calls.length > 0 && calls.every(call => { try { JSON.parse(call.function.arguments); return true } catch { return false } }),
    reassembledArguments: Object.hasOwn(e, 'reassembledArguments') && JSON.parse(chunks.flatMap(x => x.delta.toolCalls ?? []).map(call => call.function.arguments ?? '').join('') || 'null'),
    emptyDeltaTolerated: chunks?.some(x => Object.keys(x.delta).length === 0),
    toolIndexes: calls.map(call => call.index),
  }
  for (const [key, value] of Object.entries(e)) {
    assert.ok(Object.hasOwn(observations, key), `${c.id}: unhandled expectation ${key}`)
    assert.deepEqual(observations[key], value, `${c.id}: ${key}`)
  }
  // Compare meaningful outputs; provider-specific raw metadata remains available to callers.
  if (actual.response) actual.response = responseProjection(actual.response)
  if (actual.chunks) actual.chunks = streamProjection(actual.chunks)
  if (actual.error?.code === 'PROVIDER_ERROR') delete actual.error.code
  return canonical(actual)
}

async function tsHalf() {
  const report = []
  for (const c of cases) {
    try {
      const field = ['request', 'response', 'chunks'].find(k => c[k] !== undefined)
      let valid = true
      if (field) {
        valid = (field === 'chunks' ? c[field] : [c[field]]).every(v => validate(field, v))
        assert.equal(valid, c.valid, `${c.id}: schema validity`)
      }
      report.push({ id: c.id, actual: check(c, valid ? await execute(c) : { rejected: true }) })
    } catch (error) { throw new Error(`${c.id}: ${error.message}`, { cause: error }) }
  }
  writeFileSync(resolve(outDir, 'protocol-ts.json'), JSON.stringify(report, null, 2))
  console.log(`TS protocol: ${report.length} cases executed`)
}
function pythonHalf() {
  const result = spawnSync('python3', [resolve(ROOT, 'scripts/protocol-python.py'), fixtureDir, resolve(outDir, 'protocol-python-raw.json')], { cwd: ROOT, env: { ...process.env, PYTHONPATH: ['core','openai','openai-compatible','gemini'].map(p => resolve(ROOT, `python/packages/${p}/src`)).join(':') }, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr + result.stdout)
  const report = JSON.parse(readFileSync(resolve(outDir, 'protocol-python-raw.json'), 'utf8')).map((entry, i) => ({ id: entry.id, actual: check(cases[i], canonical(entry.actual)) }))
  writeFileSync(resolve(outDir, 'protocol-python.json'), JSON.stringify(report, null, 2))
  console.log(`Python protocol: ${report.length} cases executed`)
}
if (process.argv.includes('--diff')) {
  assert.deepEqual(JSON.parse(readFileSync(resolve(outDir, 'protocol-ts.json'), 'utf8')), JSON.parse(readFileSync(resolve(outDir, 'protocol-python.json'), 'utf8')))
  console.log(`Cross-language diff: ${cases.length} cases, 0 mismatches`)
} else if (process.argv.includes('--python')) pythonHalf()
else await tsHalf()
