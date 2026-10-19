import { providerJSON, providerStream, resolveProviderRuntime, PolyLLMError, type ChatContext, type JsonRecord, type LLMPlugin, type ProviderConfig, type ModelSpec, type UnifiedRequest, type UnifiedResponse, type UnifiedStreamChunk } from '@you-want/polyllm-core'
import { deepSeekModels } from './models.js'
import {
  buildDeepSeekRequestBody,
  parseDeepSeekModelsResponse,
  parseDeepSeekResponse,
  parseDeepSeekStreamEvent,
  type DeepSeekStreamEvent,
} from './wire.js'

const DEFAULT_BASE_URL = 'https://api.deepseek.com/v1'

function endpoint(baseUrl: string, path: string): string {
  return `${baseUrl || DEFAULT_BASE_URL}${path}`
}

export const deepSeekPlugin: LLMPlugin = {
  provider: 'deepseek',
  models: deepSeekModels,
  createModelSpec(id: string): ModelSpec {
    return {
      id,
      provider: 'deepseek',
      capabilities: {
        streaming: true,
        vision: false,
        functionCalling: false,
        jsonMode: false,
        systemPrompt: true,
      },
      params: {
        temperature: { min: 0, max: 2, default: 1 },
        maxTokens: { min: 1, max: 8192, default: 4096, field: 'max_tokens' },
        topP: { min: 0, max: 1, default: 1 },
      },
      contextWindow: 0,
      maxOutput: 4096,
    }
  },
  async listModels(config: ProviderConfig) {
    const runtime = resolveProviderRuntime('deepseek', config)
    const headers = { 'content-type': 'application/json', authorization: `Bearer ${runtime.apiKey}`, ...runtime.headers }
    const baseUrl = runtime.baseUrl || DEFAULT_BASE_URL
    return providerJSON('deepseek', `${baseUrl.replace(/\/$/, '')}/models`, { headers }, {}, parseDeepSeekModelsResponse)
  },
  async chat(request: UnifiedRequest, config: ProviderConfig, context: ChatContext): Promise<UnifiedResponse> {
    const runtime = resolveProviderRuntime('deepseek', config)
    const headers = { 'content-type': 'application/json', authorization: `Bearer ${runtime.apiKey}`, ...runtime.headers }
    const baseUrl = runtime.baseUrl || DEFAULT_BASE_URL
    return providerJSON('deepseek', `${baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST', headers, body: JSON.stringify(buildDeepSeekRequestBody(request, context)),
    }, context, data => parseDeepSeekResponse(data, context.model.id))
  },
  async *chatStream(request: UnifiedRequest, config: ProviderConfig, context: ChatContext): AsyncIterable<UnifiedStreamChunk> {
    const runtime = resolveProviderRuntime('deepseek', config)
    const headers = { 'content-type': 'application/json', authorization: `Bearer ${runtime.apiKey}`, ...runtime.headers }
    const baseUrl = runtime.baseUrl || DEFAULT_BASE_URL
    yield* providerStream('deepseek', `${baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST', headers, body: JSON.stringify(buildDeepSeekRequestBody({ ...request, stream: true }, context)),
    }, context, event => [parseDeepSeekStreamEvent(event as DeepSeekStreamEvent, context.model.id)])
  },
}

export { deepSeekModels, buildDeepSeekRequestBody, parseDeepSeekResponse, parseDeepSeekStreamEvent }
