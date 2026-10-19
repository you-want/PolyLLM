import { providerJSON, providerStream, resolveProviderRuntime, PolyLLMError, type ChatContext, type JsonRecord, type LLMPlugin, type ProviderConfig, type ModelSpec, type UnifiedRequest, type UnifiedResponse, type UnifiedStreamChunk } from '@you-want/polyllm-core'
import { openAIModels } from './models.js'
import {
  buildOpenAIRequestBody,
  parseOpenAIModelsResponse,
  parseOpenAIResponse,
  parseOpenAIStreamEvent,
  type OpenAIStreamEvent,
} from './wire.js'

const DEFAULT_BASE_URL = 'https://api.openai.com/v1'

function endpoint(baseUrl: string, path: string): string {
  return `${baseUrl || DEFAULT_BASE_URL}${path}`
}

export const openAIPlugin: LLMPlugin = {
  provider: 'openai',
  models: openAIModels,
  createModelSpec(id: string): ModelSpec {
    return {
      id,
      provider: 'openai',
      capabilities: {
        streaming: true,
        vision: false,
        functionCalling: false,
        jsonMode: false,
        systemPrompt: true,
      },
      params: {
        temperature: { min: 0, max: 2, default: 1 },
        maxTokens: { min: 16, max: 16384, default: 4096, field: 'max_completion_tokens' },
        topP: { min: 0, max: 1, default: 1 },
      },
      contextWindow: 0,
      maxOutput: 4096,
    }
  },
  async listModels(config: ProviderConfig) {
    const runtime = resolveProviderRuntime('openai', config)
    const headers = { 'content-type': 'application/json', authorization: `Bearer ${runtime.apiKey}`, ...runtime.headers }
    const baseUrl = runtime.baseUrl || DEFAULT_BASE_URL
    return providerJSON('openai', `${baseUrl.replace(/\/$/, '')}/models`, { headers }, {}, parseOpenAIModelsResponse)
  },
  async chat(request: UnifiedRequest, config: ProviderConfig, context: ChatContext): Promise<UnifiedResponse> {
    const runtime = resolveProviderRuntime('openai', config)
    const headers = { 'content-type': 'application/json', authorization: `Bearer ${runtime.apiKey}`, ...runtime.headers }
    const baseUrl = runtime.baseUrl || DEFAULT_BASE_URL
    return providerJSON('openai', `${baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST', headers, body: JSON.stringify(buildOpenAIRequestBody(request, context)),
    }, context, data => parseOpenAIResponse(data, context.model.id))
  },
  async *chatStream(request: UnifiedRequest, config: ProviderConfig, context: ChatContext): AsyncIterable<UnifiedStreamChunk> {
    const runtime = resolveProviderRuntime('openai', config)
    const headers = { 'content-type': 'application/json', authorization: `Bearer ${runtime.apiKey}`, ...runtime.headers }
    const baseUrl = runtime.baseUrl || DEFAULT_BASE_URL
    yield* providerStream('openai', `${baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST', headers, body: JSON.stringify(buildOpenAIRequestBody({ ...request, stream: true }, context)),
    }, context, event => [parseOpenAIStreamEvent(event as OpenAIStreamEvent, context.model.id)])
  },
}

export {
  openAIModels,
  buildOpenAIRequestBody,
  parseOpenAIModelsResponse,
  parseOpenAIResponse,
  parseOpenAIStreamEvent,
  type OpenAIStreamEvent,
}
