import {
  classifyHttpStatus,
  extractErrorExcerpt,
  isRetryableCategory,
  parseRetryAfter,
  PolyLLMError,
  providerTransportError,
  type ChatContext,
  type ErrorCategory,
  type JsonRecord,
  type LLMPlugin,
  type ProviderModelInfo,
  type ProviderConfig,
  type ModelSpec,
  type UnifiedRequest,
  type UnifiedResponse,
  type UnifiedStreamChunk,
} from '@you-want/polyllm-core'
import {
  buildOpenAIRequestBody,
  parseOpenAIResponse,
  parseOpenAIStreamEvent,
  type OpenAIStreamEvent,
} from '@you-want/polyllm-openai'
import { ollamaModels } from './models.js'

const DEFAULT_BASE_URL = 'http://127.0.0.1:11434'

function combineSignals(signal: AbortSignal | undefined, timeoutMs: number | undefined): AbortSignal | undefined {
  if (!timeoutMs) return signal
  const timeout = AbortSignal.timeout(timeoutMs)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

async function readErrorBody(response: Response): Promise<Record<string, unknown> | string> {
  const text = await response.text()
  if (!text) return ''
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    return text
  }
}

function providerFetchError(provider: string, error: unknown, context: ChatContext, label: string): PolyLLMError {
  return providerTransportError(provider, error, label, context.timeoutMs !== undefined, context.timeoutMs)
}


async function providerHttpFailure(provider: string, response: Response, label: string): Promise<PolyLLMError> {
  const body = await readErrorBody(response)
  const excerpt = extractErrorExcerpt(body)
  const category: ErrorCategory = classifyHttpStatus(response.status)
  const details: Record<string, unknown> = {
    provider,
    status: response.status,
    category,
    retryable: isRetryableCategory(category),
    label,
  }
  const retryAfter = parseRetryAfter(response.headers.get('retry-after'))
  if (retryAfter !== undefined) details.retryAfterSeconds = retryAfter
  return new PolyLLMError('PROVIDER_ERROR', `${label}: ${response.status} ${excerpt}`, details)
}

function resolveBaseUrl(config: ProviderConfig): string {
  return config.baseUrl?.trim() || DEFAULT_BASE_URL
}

function resolveHeaders(config: ProviderConfig): Record<string, string> {
  return { ...config.headers }
}

interface OllamaTagsResponse {
  models?: { name?: string; model?: string; size?: number; modified_at?: string }[]
}

function parseOllamaTagsResponse(data: JsonRecord): ProviderModelInfo[] {
  const response = data as unknown as OllamaTagsResponse
  return (response.models ?? []).flatMap((model) => {
    const id = model.name ?? model.model
    if (!id) return []
    return [{
      id,
      displayName: id,
      createdAt: model.modified_at,
      metadata: { size: model.size },
    }]
  })
}

export const ollamaPlugin: LLMPlugin = {
  provider: 'ollama',
  models: ollamaModels,
  createModelSpec(id: string): ModelSpec {
    return {
      id,
      provider: 'ollama',
      capabilities: {
        streaming: true,
        vision: false,
        functionCalling: true,
        jsonMode: false,
        systemPrompt: true,
      },
      params: {
        temperature: { min: 0, max: 2, default: 1 },
        maxTokens: { min: 1, max: 4096, default: 4096, field: 'max_tokens' },
        topP: { min: 0, max: 1, default: 1 },
      },
      contextWindow: 0,
      maxOutput: 4096,
    }
  },
  async listModels(config: ProviderConfig): Promise<ProviderModelInfo[]> {
    const baseUrl = resolveBaseUrl(config)
    // Use Ollama's native /api/tags which lists all locally pulled models
    let response: Response
    try {
      response = await fetch(`${baseUrl.replace(/\/$/, '')}/api/tags`, {
        headers: resolveHeaders(config),
      })
    } catch (error) {
      throw providerTransportError('ollama', error, 'Ollama 模型列表获取', false)
    }
    if (!response.ok) throw await providerHttpFailure('ollama', response, 'Ollama 模型列表获取失败')
    const data = (await response.json()) as JsonRecord
    return parseOllamaTagsResponse(data)
  },
  async chat(
    request: UnifiedRequest,
    config: ProviderConfig,
    context: ChatContext,
  ): Promise<UnifiedResponse> {
    const baseUrl = resolveBaseUrl(config)
    let response: Response
    try {
      response = await fetch(`${baseUrl.replace(/\/$/, '')}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...resolveHeaders(config) },
        body: JSON.stringify(buildOpenAIRequestBody(request, context)),
        signal: combineSignals(context.signal, context.timeoutMs) ?? null,
      })
    } catch (error) {
      throw providerFetchError('ollama', error, context, 'Ollama API 调用')
    }
    if (!response.ok) throw await providerHttpFailure('ollama', response, 'Ollama API 错误')
    const data = (await response.json()) as JsonRecord
    return parseOpenAIResponse(data, context.model.id)
  },
  async *chatStream(
    request: UnifiedRequest,
    config: ProviderConfig,
    context: ChatContext,
  ): AsyncIterable<UnifiedStreamChunk> {
    const baseUrl = resolveBaseUrl(config)
    let response: Response
    try {
      response = await fetch(`${baseUrl.replace(/\/$/, '')}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...resolveHeaders(config) },
        body: JSON.stringify(buildOpenAIRequestBody({ ...request, stream: true }, context)),
        signal: combineSignals(context.signal, context.timeoutMs) ?? null,
      })
    } catch (error) {
      throw providerFetchError('ollama', error, context, 'Ollama API 流式调用')
    }
    if (!response.ok) throw await providerHttpFailure('ollama', response, 'Ollama API 错误')
    if (!response.body)
      throw new PolyLLMError('PROVIDER_ERROR', 'Ollama API 未返回响应流', {
        provider: 'ollama',
        category: 'connection',
        retryable: true,
      })

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) continue
        const payload = trimmed.slice(5).trim()
        if (!payload || payload === '[DONE]') continue
        yield parseOpenAIStreamEvent(JSON.parse(payload) as OpenAIStreamEvent, context.model.id)
      }
    }
  },
}

export {
  ollamaModels,
  parseOllamaTagsResponse,
}
