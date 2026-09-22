import {
  PolyLLMError,
  type ChatContext,
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

async function readErrorMessage(response: Response): Promise<string> {
  const text = await response.text()
  return text || response.statusText
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
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/api/tags`, {
      headers: resolveHeaders(config),
    })
    if (!response.ok) {
      throw new PolyLLMError(
        'PROVIDER_ERROR',
        `Ollama 模型列表获取失败: ${response.status} ${await readErrorMessage(response)}`,
        { status: response.status, provider: 'ollama' },
      )
    }
    const data = (await response.json()) as JsonRecord
    return parseOllamaTagsResponse(data)
  },
  async chat(
    request: UnifiedRequest,
    config: ProviderConfig,
    context: ChatContext,
  ): Promise<UnifiedResponse> {
    const baseUrl = resolveBaseUrl(config)
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...resolveHeaders(config) },
      body: JSON.stringify(buildOpenAIRequestBody(request, context)),
      signal: combineSignals(context.signal, context.timeoutMs) ?? null,
    })
    if (!response.ok) {
      throw new PolyLLMError('PROVIDER_ERROR', `Ollama API 错误: ${response.status} ${await readErrorMessage(response)}`, {
        status: response.status,
        provider: 'ollama',
      })
    }
    const data = (await response.json()) as JsonRecord
    return parseOpenAIResponse(data, context.model.id)
  },
  async *chatStream(
    request: UnifiedRequest,
    config: ProviderConfig,
    context: ChatContext,
  ): AsyncIterable<UnifiedStreamChunk> {
    const baseUrl = resolveBaseUrl(config)
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...resolveHeaders(config) },
      body: JSON.stringify(buildOpenAIRequestBody({ ...request, stream: true }, context)),
      signal: combineSignals(context.signal, context.timeoutMs) ?? null,
    })
    if (!response.ok) {
      throw new PolyLLMError('PROVIDER_ERROR', `Ollama API 错误: ${response.status} ${await readErrorMessage(response)}`, {
        status: response.status,
        provider: 'ollama',
      })
    }
    if (!response.body) throw new PolyLLMError('PROVIDER_ERROR', 'Ollama API 未返回响应流')

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
