import { providerJSON, providerStream, resolveProviderRuntime, PolyLLMError, type ChatContext, type JsonRecord, type LLMPlugin, type ListContext, type ProviderConfig, type ModelSpec, type UnifiedRequest, type UnifiedResponse, type UnifiedStreamChunk } from '@you-want/polyllm-core'
import { geminiModels } from './models.js'
import {
  buildGeminiRequestBody,
  createGeminiStreamState,
  normalizeGeminiModelId,
  parseGeminiModelsResponse,
  parseGeminiResponse,
  parseGeminiStreamEvent,
} from './wire.js'

const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta'

function endpoint(baseUrl: string, model: string, action: 'generateContent' | 'streamGenerateContent'): string {
  const normalized = normalizeGeminiModelId(model)
  const suffix = action === 'streamGenerateContent' ? '?alt=sse' : ''
  return `${baseUrl.replace(/\/$/, '')}/models/${normalized}:${action}${suffix}`
}

export const geminiPlugin: LLMPlugin = {
  provider: 'gemini',
  models: geminiModels,
  createModelSpec(id: string): ModelSpec {
    return {
      id,
      provider: 'gemini',
      capabilities: {
        streaming: true,
        vision: false,
        functionCalling: true,
        jsonMode: false,
        systemPrompt: true,
      },
      params: {
        temperature: { min: 0, max: 2, default: 1 },
        maxTokens: { min: 1, max: 65536, default: 8192, field: 'maxOutputTokens' },
        topP: { min: 0, max: 1, default: 1 },
      },
      contextWindow: 0,
      maxOutput: 8192,
    }
  },
  async listModels(config: ProviderConfig, context: ListContext = {}) {
    const runtime = resolveProviderRuntime('gemini', config)
    const headers = { 'content-type': 'application/json', 'x-goog-api-key': runtime.apiKey, ...runtime.headers }
    const baseUrl = runtime.baseUrl || DEFAULT_BASE_URL
    return providerJSON('gemini', `${baseUrl.replace(/\/$/, '')}/models`, { headers }, context, parseGeminiModelsResponse)
  },
  async chat(request: UnifiedRequest, config: ProviderConfig, context: ChatContext): Promise<UnifiedResponse> {
    const runtime = resolveProviderRuntime('gemini', config)
    const headers = { 'content-type': 'application/json', 'x-goog-api-key': runtime.apiKey, ...runtime.headers }
    const baseUrl = runtime.baseUrl || DEFAULT_BASE_URL
    return providerJSON('gemini', endpoint(baseUrl, context.model.id, 'generateContent'), {
      method: 'POST', headers, body: JSON.stringify(buildGeminiRequestBody(request, context)),
    }, context, data => parseGeminiResponse(data, context.model.id))
  },
  async *chatStream(request: UnifiedRequest, config: ProviderConfig, context: ChatContext): AsyncIterable<UnifiedStreamChunk> {
    const runtime = resolveProviderRuntime('gemini', config)
    const headers = { 'content-type': 'application/json', 'x-goog-api-key': runtime.apiKey, ...runtime.headers }
    const baseUrl = runtime.baseUrl || DEFAULT_BASE_URL
    const state = createGeminiStreamState()
    yield* providerStream('gemini', endpoint(baseUrl, context.model.id, 'streamGenerateContent'), {
      method: 'POST', headers, body: JSON.stringify(buildGeminiRequestBody({ ...request, stream: true }, context)),
    }, context, event => parseGeminiStreamEvent(event, state, context.model.id))
  },
}

export { geminiModels }
