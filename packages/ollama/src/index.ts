import { providerJSON, providerStream, resolveProviderRuntime, PolyLLMError, type ChatContext, type JsonRecord, type LLMPlugin, type ListContext, type ProviderModelInfo, type ProviderConfig, type ModelSpec, type UnifiedRequest, type UnifiedResponse, type UnifiedStreamChunk } from '@you-want/polyllm-core'
import {
  buildOpenAIRequestBody,
  parseOpenAIResponse,
  parseOpenAIStreamEvent,
  type OpenAIStreamEvent,
} from '@you-want/polyllm-openai'
import { ollamaModels } from './models.js'

const DEFAULT_BASE_URL = 'http://127.0.0.1:11434'

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
  async listModels(config: ProviderConfig, context: ListContext = {}) {
    const baseUrl = resolveBaseUrl(config)
    const headers = { 'content-type': 'application/json', ...resolveHeaders(config) }
    return providerJSON('ollama', `${baseUrl.replace(/\/$/, '')}/api/tags`, { headers }, context, parseOllamaTagsResponse, [config.apiKey ?? ''])
  },
  async chat(request: UnifiedRequest, config: ProviderConfig, context: ChatContext): Promise<UnifiedResponse> {
    const baseUrl = resolveBaseUrl(config)
    const headers = { 'content-type': 'application/json', ...resolveHeaders(config) }
    return providerJSON('ollama', `${baseUrl.replace(/\/$/, '')}/v1/chat/completions`, {
      method: 'POST', headers, body: JSON.stringify(buildOpenAIRequestBody(request, context)),
    }, context, data => parseOpenAIResponse(data, context.model.id), [config.apiKey ?? ''])
  },
  async *chatStream(request: UnifiedRequest, config: ProviderConfig, context: ChatContext): AsyncIterable<UnifiedStreamChunk> {
    const baseUrl = resolveBaseUrl(config)
    const headers = { 'content-type': 'application/json', ...resolveHeaders(config) }
    yield* providerStream('ollama', `${baseUrl.replace(/\/$/, '')}/v1/chat/completions`, {
      method: 'POST', headers, body: JSON.stringify(buildOpenAIRequestBody({ ...request, stream: true }, context)),
    }, context, event => [parseOpenAIStreamEvent(event as OpenAIStreamEvent, context.model.id)], [config.apiKey ?? ''])
  },
}

export {
  ollamaModels,
  parseOllamaTagsResponse,
}
