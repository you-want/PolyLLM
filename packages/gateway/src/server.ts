//! Local gateway server (prototype): exposes OpenAI- and Anthropic-compatible
//! endpoints over the PolyLLM plugin system, with exact-match routes, model
//! failover groups, API-key account pools (rotation on retryable errors),
//! in-memory usage counters, and opt-in local privacy masking.
//!
//! Deliberately excluded (magpie parity gaps, documented in the README):
//! subscription/OAuth account discovery, persistent quota history, and GUI
//! packaging.

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

export interface GatewayProviderConfig extends ProviderConfig {
  /** API-key pool: on a retryable failure (429/5xx/connection), the next key
   *  takes over before the gateway moves to the next model. */
  accounts?: string[]
}

export interface GatewayRoute {
  match: string
  target: string
}

export interface GatewayGroup {
  name: string
  models: string[]
}

export interface GatewayConfig {
  providers: Record<string, GatewayProviderConfig>
  plugins?: string[]
  routes?: GatewayRoute[]
  groups?: GatewayGroup[]
  allowUnlistedModels?: boolean
  /** Local privacy masking (off by default): emails and API-key-shaped tokens
   *  in prompt content are replaced with placeholders before the request
   *  leaves the machine, and restored in the reply. */
  masking?: { enabled?: boolean; extraPatterns?: string[] }
  port?: number
  host?: string
}

export interface UsageCounters {
  requests: number
  promptTokens: number
  completionTokens: number
  totalTokens: number
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

export interface GatewayRuntime {
  /** One LLM client per account slot; slot 0 is also the no-pool client. */
  clients: Array<{ llm: ReturnType<typeof createLLM>; accountLabel: string | undefined }>
  /** Per-account in-memory usage counters (magpie `quota` equivalent). */
  usage: Map<string, UsageCounters>
  masking: { enabled: boolean; patterns: RegExp[] }
}

export function buildRuntime(config: GatewayConfig): GatewayRuntime {
  const pluginNames = config.plugins ?? Object.keys(ALL_PLUGINS)
  const plugins = pluginNames.map((name) => {
    const plugin = ALL_PLUGINS[name]
    if (!plugin) throw new PolyLLMError('INVALID_CONFIG', `gateway: 未知插件 ${name}`, { provider: name })
    return plugin
  })
  const poolSize = Math.max(
    1,
    ...Object.values(config.providers).map((provider) => provider.accounts?.length ?? 1),
  )
  const hasPool = Object.values(config.providers).some(
    (provider) => (provider.accounts?.length ?? 0) > 1,
  )
  const clients: GatewayRuntime['clients'] = []
  for (let index = 0; index < poolSize; index += 1) {
    const providers: Record<string, ProviderConfig> = {}
    for (const [provider, providerConfig] of Object.entries(config.providers)) {
      const accounts = providerConfig.accounts
      if (accounts && accounts.length > 0) {
        providers[provider] = { ...providerConfig, apiKey: accounts[index % accounts.length] }
      } else {
        const { accounts: _accounts, ...rest } = providerConfig
        providers[provider] = rest
      }
    }
    clients.push({
      llm: createLLM({
        plugins,
        providers,
        allowUnlistedModels: config.allowUnlistedModels ?? true,
      } satisfies ClientConfig),
      accountLabel: hasPool ? `account#${index + 1}` : 'default',
    })
  }
  return {
    clients,
    usage: new Map(),
    masking: {
      enabled: config.masking?.enabled ?? false,
      patterns: [
        /[\w.+-]+@[\w-]+\.[\w.]{2,}/g,
        /sk-[A-Za-z0-9]{16,}/g,
        /ghp_[A-Za-z0-9]{20,}/g,
        /xox[baprs]-[A-Za-z0-9-]{10,}/g,
        ...(config.masking?.extraPatterns ?? []).map((pattern) => new RegExp(pattern, 'g')),
      ],
    },
  }
}

// --- local privacy masking (per-request registry) ---

export interface RequestMasking {
  registry: Map<string, string>
}

export function maskText(runtime: GatewayRuntime, text: string, masking: RequestMasking): string {
  if (!runtime.masking.enabled) return text
  let masked = text
  for (const pattern of runtime.masking.patterns) {
    masked = masked.replace(pattern, (match) => {
      for (const [placeholder, original] of masking.registry) {
        if (original === match) return placeholder
      }
      const placeholder = `::POLYLLM_MASK_${masking.registry.size + 1}::`
      masking.registry.set(placeholder, match)
      return placeholder
    })
  }
  return masked
}

function maskRequest(runtime: GatewayRuntime, request: UnifiedRequest, masking: RequestMasking): void {
  for (const message of request.messages) {
    if (typeof message.content === 'string') {
      message.content = maskText(runtime, message.content, masking)
    } else {
      for (const part of message.content) {
        if (part.type === 'text' && typeof part.text === 'string') {
          part.text = maskText(runtime, part.text, masking)
        }
      }
    }
  }
}

function unmaskDeep(value: unknown, masking: RequestMasking): unknown {
  if (typeof value === 'string') {
    let restored = value
    for (const [placeholder, original] of masking.registry) {
      restored = restored.split(placeholder).join(original)
    }
    return restored
  }
  if (Array.isArray(value)) return value.map((item) => unmaskDeep(item, masking))
  if (value !== null && typeof value === 'object') {
    const out: JsonRecord = {}
    for (const [key, item] of Object.entries(value as JsonRecord)) {
      out[key] = unmaskDeep(item, masking)
    }
    return out
  }
  return value
}

// --- routing / failover ---

export function resolveRoute(config: GatewayConfig, model: string): { targets: string[]; failover: boolean } {
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

interface ChatOutcome {
  result: Awaited<ReturnType<ReturnType<typeof createLLM>['chat']>>
  header: string | undefined
}

/** Chat with two failover layers: accounts within a target (key pool), then
 *  models within a group. Only retryable errors (429/5xx/connection) rotate.
 *  Usage counters accumulate per account (in-memory, magpie `quota` 等价物). */
async function chatWithFailover(
  runtime: GatewayRuntime,
  request: UnifiedRequest,
  targets: string[],
  failover: boolean,
): Promise<ChatOutcome> {
  const failed: string[] = []
  let lastError: unknown
  for (const target of targets) {
    for (let slot = 0; slot < runtime.clients.length; slot += 1) {
      const client = runtime.clients[slot]
      const label = client.accountLabel ?? 'default'
      try {
        const result = await client.llm.chat(target, request, {})
        const counters = runtime.usage.get(label) ?? {
          requests: 0,
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
        }
        counters.requests += 1
        counters.promptTokens += result.usage.promptTokens
        counters.completionTokens += result.usage.completionTokens
        counters.totalTokens += result.usage.totalTokens
        runtime.usage.set(label, counters)
        const header =
          failed.length > 0
            ? `${failed.join(' | ')} -> ${target}${client.accountLabel !== undefined ? ` (${client.accountLabel})` : ''}`
            : undefined
        return { result, header }
      } catch (error) {
        lastError = error
        failed.push(
          `${target}${client.accountLabel !== undefined ? `(${client.accountLabel})` : ''}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        )
        const retryable = isRetryable(error)
        const moreAccounts = slot < runtime.clients.length - 1
        const moreTargets = target !== targets[targets.length - 1]
        if (!(retryable && (moreAccounts || moreTargets))) break
      }
    }
  }
  throw lastError
}

// --- wire helpers ---

function sendJson(
  response: ServerResponse,
  status: number,
  body: JsonRecord,
  headers: Record<string, string> = {},
): void {
  response.writeHead(status, { 'content-type': 'application/json', ...headers })
  response.end(JSON.stringify(body))
}

async function readBody(request: IncomingMessage): Promise<JsonRecord> {
  let raw = ''
  for await (const chunk of request) raw += typeof chunk === 'string' ? chunk : String(chunk)
  if (!raw.trim()) return {}
  return JSON.parse(raw) as JsonRecord
}

async function writeStream(
  response: ServerResponse,
  streamIterable: AsyncIterable<import('@you-want/polyllm-core').UnifiedStreamChunk>,
  protocol: 'openai' | 'anthropic',
  masking: RequestMasking,
): Promise<void> {
  if (protocol === 'anthropic') {
    const state = createAnthropicRenderState()
    for await (const rawChunk of streamIterable) {
      const chunk = unmaskDeep(rawChunk, masking) as typeof rawChunk
      for (const event of renderAnthropicStreamChunk(chunk, state)) {
        response.write(`event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`)
      }
    }
    response.write(
      `event: ${ANTHROPIC_MESSAGE_STOP.event}\ndata: ${JSON.stringify(ANTHROPIC_MESSAGE_STOP.data)}\n\n`,
    )
  } else {
    for await (const rawChunk of streamIterable) {
      response.write(`data: ${JSON.stringify(unmaskDeep(renderOpenAIStreamChunk(rawChunk), masking))}\n\n`)
    }
    response.write('data: [DONE]\n\n')
  }
  response.end()
}

// --- endpoints ---

async function handleChatEndpoint(
  runtime: GatewayRuntime,
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

  const masking: RequestMasking = { registry: new Map() }
  maskRequest(runtime, unified, masking)
  const stream = unified.stream === true

  try {
    if (stream) {
      // Connect-phase failover across accounts and targets happens BEFORE the
      // response head is written (a late setHeader after writeHead throws);
      // once chunks flow, errors surface mid-stream (never replayed).
      let lastError: unknown
      let establishedStream: AsyncIterable<import('@you-want/polyllm-core').UnifiedStreamChunk> | undefined
      let failoverHeader: string | undefined
      for (const target of targets) {
        if (establishedStream) break
        for (const client of runtime.clients) {
          try {
            const streamIterable = client.llm.chatStream(target, unified, {})
            const iterator = streamIterable[Symbol.asyncIterator]()
            const first = await iterator.next()
            establishedStream = (async function* () {
              if (!first.done) yield first.value
              yield* streamIterable
            })()
            if (runtime.clients.length > 1 || targets.length > 1) {
              failoverHeader = `${targets[0]} -> ${target}${client.accountLabel !== undefined ? ` (${client.accountLabel})` : ''}`
            }
            break
          } catch (error) {
            lastError = error
            if (!isRetryable(error)) break
          }
        }
      }
      if (!establishedStream) throw lastError
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        ...(failoverHeader !== undefined ? { 'x-polyllm-failover': failoverHeader } : {}),
      })
      await writeStream(response, establishedStream, protocol, masking)
      return
    }

    const { result, header } = await chatWithFailover(runtime, unified, targets, failover)
    const rendered = protocol === 'anthropic' ? renderAnthropicResponse(result) : renderOpenAIResponse(result)
    const unmasked = unmaskDeep(rendered, masking)
    sendJson(response, 200, unmasked as JsonRecord, header !== undefined ? { 'x-polyllm-failover': header } : {})
  } catch (error) {
    const polyllmError = error instanceof PolyLLMError ? error : new PolyLLMError('PROVIDER_ERROR', String(error))
    const status = polyllmError.code === 'UNKNOWN_MODEL' ? 404 : 502
    const errorBody =
      protocol === 'anthropic'
        ? renderAnthropicError(polyllmError)
        : { error: { message: polyllmError.message, code: polyllmError.code } }
    sendJson(response, status, unmaskDeep(errorBody, masking) as JsonRecord)
  }
}

async function handleRequest(
  runtime: GatewayRuntime,
  config: GatewayConfig,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const url = (request.url ?? '/').split('?')[0]
  if (request.method === 'GET' && (url === '/v1/models' || url === '/models')) {
    const models = runtime.clients[0].llm.listModels().map((spec) => ({
      id: `${spec.provider}:${spec.id}`,
      object: 'model',
      owned_by: spec.provider,
    }))
    sendJson(response, 200, { object: 'list', data: models })
    return
  }
  if (request.method === 'POST' && (url === '/v1/chat/completions' || url === '/chat/completions')) {
    await handleChatEndpoint(runtime, config, request, response, 'openai')
    return
  }
  if (request.method === 'POST' && (url === '/v1/messages' || url === '/messages')) {
    await handleChatEndpoint(runtime, config, request, response, 'anthropic')
    return
  }
  if (request.method === 'GET' && (url === '/usage' || url === '/v1/usage')) {
    const accounts = [...runtime.usage.entries()].map(([account, counters]) => ({ account, ...counters }))
    sendJson(response, 200, { accounts })
    return
  }
  if (request.method === 'GET' && (url === '/health' || url === '/healthz')) {
    sendJson(response, 200, { ok: true, gateway: 'polyllm' })
    return
  }
  sendJson(response, 404, { error: { message: `gateway: 未知路由 ${request.method} ${url}` } })
}

export function createGatewayServer(config: GatewayConfig): Server {
  const runtime = buildRuntime(config)
  return createServer((request, response) => {
    void handleRequest(runtime, config, request, response).catch((error: unknown) => {
      if (!response.headersSent) {
        sendJson(response, 500, { error: { message: error instanceof Error ? error.message : String(error) } })
      } else {
        response.end()
      }
    })
  })
}

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
