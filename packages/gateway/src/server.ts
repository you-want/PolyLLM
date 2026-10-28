//! Local gateway server (prototype): exposes OpenAI- and Anthropic-compatible
//! endpoints over the PolyLLM plugin system, with exact-match routes and
//! failover groups (the magpie-style core, bounded to protocol + routing —
//! no account discovery, no key handling beyond ProviderConfig).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import {
  createLLM,
  PolyLLMError,
  type ClientConfig,
  type JsonRecord,
  type LLMPlugin,
  type ProviderConfig,
  type UnifiedRequest,
} from '@you-want/polyllm-core'
import { anthropicPlugin } from '@you-want/polyllm-anthropic'
import { deepSeekPlugin } from '@you-want/polyllm-deepseek'
import { geminiPlugin } from '@you-want/polyllm-gemini'
import { ollamaPlugin } from '@you-want/polyllm-ollama'
import { openAIPlugin } from '@you-want/polyllm-openai'
import { openAICompatiblePlugin } from '@you-want/polyllm-openai-compatible'
import {
  parseOpenAIRequest,
  renderOpenAIResponse,
  renderOpenAIStreamChunk,
} from './translate-openai.js'
import {
  ANTHROPIC_MESSAGE_STOP,
  createAnthropicRenderState,
  parseAnthropicRequest,
  renderAnthropicError,
  renderAnthropicResponse,
  renderAnthropicStreamChunk,
} from './translate-anthropic.js'

export interface GatewayRoute {
  /** Exact incoming model id (e.g. `claude-sonnet-4-5`). */
  match: string
  /** Target model in `provider:id` form (e.g. `deepseek:deepseek-chat`). */
  target: string
}

export interface GatewayGroup {
  /** Referenced as `group:<name>` in requests. */
  name: string
  models: string[]
}

export interface GatewayConfig {
  /** Provider configs keyed by provider id (same shape as polyllm.config.json). */
  providers: Record<string, ProviderConfig>
  /** Provider plugins to expose. Default: all built-in providers. */
  plugins?: string[]
  /** Exact-model routes (magpie-style "agent X runs on model Y"). */
  routes?: GatewayRoute[]
  /** Failover groups, referenced as `group:<name>`. */
  groups?: GatewayGroup[]
  /** Allow unlisted models via the plugin's conservative spec. Default true. */
  allowUnlistedModels?: boolean
  port?: number
  host?: string
}

const ALL_PLUGINS: Record<string, LLMPlugin> = {
  openai: openAIPlugin,
  deepseek: deepSeekPlugin,
  anthropic: anthropicPlugin,
  gemini: geminiPlugin,
  ollama: ollamaPlugin,
  'openai-compatible': openAICompatiblePlugin,
}

const RETRYABLE_CATEGORIES = new Set(['rate_limited', 'server', 'connection'])

interface ResolvedTarget {
  targets: string[]
  failover: boolean
}

/** Route resolution: `group:<name>` → group members; exact route → target;
 *  otherwise pass the model through to the registry unchanged. */
export function resolveRoute(config: GatewayConfig, model: string): ResolvedTarget {
  if (model.startsWith('group:')) {
    const name = model.slice('group:'.length)
    const group = (config.groups ?? []).find((candidate) => candidate.name === name)
    if (!group) {
      throw new PolyLLMError('UNKNOWN_MODEL', `gateway: 未定义的路由组 group:${name}`, { group: name })
    }
    return { targets: group.models, failover: true }
  }
  const route = (config.routes ?? []).find((candidate) => candidate.match === model)
  if (route) return { targets: [route.target], failover: false }
  return { targets: [model], failover: false }
}

function isRetryable(error: unknown): boolean {
  return (
    error instanceof PolyLLMError &&
    typeof error.details?.category === 'string' &&
    RETRYABLE_CATEGORIES.has(error.details.category as string)
  )
}

function sendJson(response: ServerResponse, status: number, body: JsonRecord, headers: Record<string, string> = {}): void {
  response.writeHead(status, { 'content-type': 'application/json', ...headers })
  response.end(JSON.stringify(body))
}

async function readBody(request: IncomingMessage): Promise<JsonRecord> {
  let raw = ''
  for await (const chunk of request) raw += typeof chunk === 'string' ? chunk : String(chunk)
  if (!raw.trim()) return {}
  return JSON.parse(raw) as JsonRecord
}

/** Run one chat attempt with the given target; fails over on retryable
 *  errors when the target is part of a group. Returns the response plus a
 *  `x-polyllm-failover` header value of the form `failed attempts -> served`. */
async function chatWithFailover(
  llm: ReturnType<typeof createLLM>,
  request: UnifiedRequest,
  targets: string[],
  failover: boolean,
): Promise<{ result: Awaited<ReturnType<ReturnType<typeof createLLM>['chat']>>; header: string | undefined }> {
  const failed: string[] = []
  let lastError: unknown
  for (let index = 0; index < targets.length; index += 1) {
    const target = targets[index]
    try {
      const result = await llm.chat(target, request, {})
      const header = failed.length > 0 ? `${failed.join(' | ')} -> ${target}` : undefined
      return { result, header }
    } catch (error) {
      lastError = error
      failed.push(`${target}: ${error instanceof Error ? error.message : String(error)}`)
      if (!failover || index === targets.length - 1 || !isRetryable(error)) break
    }
  }
  throw lastError
}

async function handleChatEndpoint(
  llm: ReturnType<typeof createLLM>,
  config: GatewayConfig,
  request: IncomingMessage,
  response: ServerResponse,
  protocol: 'openai' | 'anthropic',
): Promise<void> {
  let body: JsonRecord
  try {
    body = await readBody(request)
  } catch {
    const error = new PolyLLMError('INVALID_CONFIG', 'gateway: 请求体不是合法 JSON', { protocol })
    sendJson(response, 400, protocol === 'anthropic' ? renderAnthropicError(error) : { error: { message: error.message } })
    return
  }

  let unified: UnifiedRequest
  try {
    unified = protocol === 'anthropic' ? parseAnthropicRequest(body) : parseOpenAIRequest(body)
  } catch (error) {
    const polyllmError = error instanceof PolyLLMError ? error : new PolyLLMError('INVALID_CONFIG', String(error))
    sendJson(response, 400, protocol === 'anthropic' ? renderAnthropicError(polyllmError) : { error: { message: polyllmError.message } })
    return
  }

  let targets: string[]
  let failover: boolean
  try {
    const resolved = resolveRoute(config, unified.model)
    targets = resolved.targets
    failover = resolved.failover
  } catch (error) {
    const polyllmError = error instanceof PolyLLMError ? error : new PolyLLMError('UNKNOWN_MODEL', String(error))
    sendJson(response, 404, protocol === 'anthropic' ? renderAnthropicError(polyllmError) : { error: { message: polyllmError.message } })
    return
  }

  const stream = unified.stream === true
  try {
    if (stream) {
      response.writeHead(200, {
        'content-type': protocol === 'anthropic' ? 'text/event-stream' : 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      const target = targets[0]
      if (failover && targets.length > 1) {
        // Connect-phase failover: try targets until chatStream() establishes.
        let established: Awaited<ReturnType<ReturnType<typeof createLLM>['chatStream']>> | undefined
        let establishedOn = target
        let lastError: unknown
        for (const candidate of targets) {
          try {
            established = llm.chatStream(candidate, unified, {})
            // Force the first chunk to surface connection/HTTP errors.
            const iterator = established[Symbol.asyncIterator]()
            const first = await iterator.next()
            established = (async function* () {
              if (!first.done) yield first.value
              yield* established!
            })()
            establishedOn = candidate
            break
          } catch (error) {
            lastError = error
            if (!isRetryable(error)) break
          }
        }
        if (!established) throw lastError
        response.setHeader('x-polyllm-failover', `${target} -> ${establishedOn}`)
        await writeStream(response, established, protocol)
        return
      }
      const streamIterable = llm.chatStream(target, unified, {})
      await writeStream(response, streamIterable, protocol)
      return
    }

    const { result, header } = await chatWithFailover(llm, unified, targets, failover)
    const headers: Record<string, string> = {}
    if (header !== undefined) headers['x-polyllm-failover'] = header
    const rendered = protocol === 'anthropic' ? renderAnthropicResponse(result) : renderOpenAIResponse(result)
    sendJson(response, 200, rendered, headers)
  } catch (error) {
    const polyllmError = error instanceof PolyLLMError ? error : new PolyLLMError('PROVIDER_ERROR', String(error))
    const status = polyllmError.code === 'UNKNOWN_MODEL' ? 404 : 502
    sendJson(response, status, protocol === 'anthropic' ? renderAnthropicError(polyllmError) : { error: { message: polyllmError.message, code: polyllmError.code } })
  }
}

async function writeStream(
  response: ServerResponse,
  streamIterable: AsyncIterable<import('@you-want/polyllm-core').UnifiedStreamChunk>,
  protocol: 'openai' | 'anthropic',
): Promise<void> {
  if (protocol === 'anthropic') {
    const state = createAnthropicRenderState()
    for await (const chunk of streamIterable) {
      for (const event of renderAnthropicStreamChunk(chunk, state)) {
        response.write(`event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`)
      }
    }
    response.write(`event: ${ANTHROPIC_MESSAGE_STOP.event}\ndata: ${JSON.stringify(ANTHROPIC_MESSAGE_STOP.data)}\n\n`)
  } else {
    for await (const chunk of streamIterable) {
      response.write(`data: ${JSON.stringify(renderOpenAIStreamChunk(chunk))}\n\n`)
    }
    response.write('data: [DONE]\n\n')
  }
  response.end()
}

/** Build the gateway HTTP server (does not listen — call `server.listen`). */
export function createGatewayServer(config: GatewayConfig): Server {
  const pluginNames = config.plugins ?? Object.keys(ALL_PLUGINS)
  const plugins = pluginNames.map((name) => {
    const plugin = ALL_PLUGINS[name]
    if (!plugin) throw new PolyLLMError('INVALID_CONFIG', `gateway: 未知插件 ${name}`, { provider: name })
    return plugin
  })
  const llm = createLLM({
    plugins,
    providers: config.providers,
    allowUnlistedModels: config.allowUnlistedModels ?? true,
  } satisfies ClientConfig)

  return createServer((request, response) => {
    void handleRequest(llm, config, request, response).catch((error: unknown) => {
      if (!response.headersSent) {
        sendJson(response, 500, { error: { message: error instanceof Error ? error.message : String(error) } })
      } else {
        response.end()
      }
    })
  })
}

async function handleRequest(
  llm: ReturnType<typeof createLLM>,
  config: GatewayConfig,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const url = (request.url ?? '/').split('?')[0]
  if (request.method === 'GET' && (url === '/v1/models' || url === '/models')) {
    const models = llm.listModels().map((spec) => ({
      id: `${spec.provider}:${spec.id}`,
      object: 'model',
      owned_by: spec.provider,
    }))
    sendJson(response, 200, { object: 'list', data: models })
    return
  }
  if (request.method === 'POST' && (url === '/v1/chat/completions' || url === '/chat/completions')) {
    await handleChatEndpoint(llm, config, request, response, 'openai')
    return
  }
  if (request.method === 'POST' && (url === '/v1/messages' || url === '/messages')) {
    await handleChatEndpoint(llm, config, request, response, 'anthropic')
    return
  }
  if (request.method === 'GET' && (url === '/health' || url === '/healthz')) {
    sendJson(response, 200, { ok: true, gateway: 'polyllm' })
    return
  }
  sendJson(response, 404, { error: { message: `gateway: 未知路由 ${request.method} ${url}` } })
}

/** Convenience: create + listen. Resolves with the actual port. */
export function startGatewayServer(config: GatewayConfig): Promise<{ server: Server; port: number }> {
  const server = createGatewayServer(config)
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(config.port ?? 0, config.host ?? '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : (config.port ?? 0)
      resolve({ server, port })
    })
  })
}
