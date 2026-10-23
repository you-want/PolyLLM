import { providerJSON, providerStream, resolveProviderRuntime, PolyLLMError, type ChatContext, type JsonRecord, type LLMPlugin, type ListContext, type ProviderConfig, type ModelSpec, type UnifiedRequest, type UnifiedResponse, type UnifiedStreamChunk } from '@you-want/polyllm-core'
import {
  buildOpenAIRequestBody,
  parseOpenAIModelsResponse,
  parseOpenAIResponse,
  parseOpenAIStreamEvent,
  type OpenAIStreamEvent,
} from '@you-want/polyllm-openai'

function endpoint(baseUrl: string, path: string): string {
  if (!baseUrl.trim()) {
    throw new PolyLLMError('INVALID_CONFIG', 'OpenAI-compatible 插件必须配置 baseUrl', {
      provider: 'openai-compatible',
    })
  }
  return `${baseUrl.replace(/\/$/, '')}${path}`
}

export const openAICompatiblePlugin: LLMPlugin = {
  provider: 'openai-compatible',
  models: [],
  createModelSpec(id: string): ModelSpec {
    return {
      id,
      provider: 'openai-compatible',
      capabilities: {
        streaming: true,
        vision: false,
        functionCalling: false,
        jsonMode: false,
        systemPrompt: true,
      },
      params: {
        temperature: { min: 0, max: 2, default: 1 },
        maxTokens: { min: 1, max: 32768, default: 4096, field: 'max_tokens' },
        topP: { min: 0, max: 1, default: 1 },
      },
      contextWindow: 0,
      maxOutput: 4096,
    }
  },
  async listModels(config: ProviderConfig, context: ListContext = {}) {
    const runtime = resolveProviderRuntime('openai-compatible', config)
    const headers = { 'content-type': 'application/json', authorization: `Bearer ${runtime.apiKey}`, ...runtime.headers }
    const baseUrl = runtime.baseUrl
    return providerJSON('openai-compatible', endpoint(baseUrl, '/models'), { headers }, context, parseOpenAIModelsResponse)
  },
  async chat(request: UnifiedRequest, config: ProviderConfig, context: ChatContext): Promise<UnifiedResponse> {
    const runtime = resolveProviderRuntime('openai-compatible', config)
    const headers = { 'content-type': 'application/json', authorization: `Bearer ${runtime.apiKey}`, ...runtime.headers }
    const baseUrl = runtime.baseUrl
    return providerJSON('openai-compatible', endpoint(baseUrl, '/chat/completions'), {
      method: 'POST', headers, body: JSON.stringify(buildOpenAIRequestBody(request, context)),
    }, context, data => parseOpenAIResponse(data, context.model.id))
  },
  async *chatStream(request: UnifiedRequest, config: ProviderConfig, context: ChatContext): AsyncIterable<UnifiedStreamChunk> {
    const runtime = resolveProviderRuntime('openai-compatible', config)
    const headers = { 'content-type': 'application/json', authorization: `Bearer ${runtime.apiKey}`, ...runtime.headers }
    const baseUrl = runtime.baseUrl
    yield* providerStream('openai-compatible', endpoint(baseUrl, '/chat/completions'), {
      method: 'POST', headers, body: JSON.stringify(buildOpenAIRequestBody({ ...request, stream: true }, context)),
    }, context, event => [parseOpenAIStreamEvent(event as OpenAIStreamEvent, context.model.id)])
  },
}

export { openaiCompatiblePresets, type OpenAICompatiblePreset } from './presets.js'
