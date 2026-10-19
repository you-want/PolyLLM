import { providerJSON, providerStream, resolveProviderRuntime, PolyLLMError, type ChatContext, type JsonRecord, type LLMPlugin, type ProviderConfig, type ModelSpec, type UnifiedRequest, type UnifiedResponse, type UnifiedStreamChunk } from '@you-want/polyllm-core'
import { anthropicModels } from './models.js'
import {
  buildAnthropicRequestBody,
  createAnthropicStreamState,
  parseAnthropicModelsResponse,
  parseAnthropicResponse,
  parseAnthropicStreamEvent,
  type AnthropicStreamEvent,
} from './wire.js'

const DEFAULT_BASE_URL = 'https://api.anthropic.com/v1'

function endpoint(baseUrl: string, path: string): string {
  return `${baseUrl || DEFAULT_BASE_URL}${path}`
}

export const anthropicPlugin: LLMPlugin = {
  provider: 'anthropic',
  models: anthropicModels,
  createModelSpec(id: string): ModelSpec {
    return {
      id,
      provider: 'anthropic',
      capabilities: {
        streaming: true,
        vision: false,
        functionCalling: false,
        jsonMode: false,
        systemPrompt: true,
      },
      params: {
        temperature: { min: 0, max: 1, default: 1 },
        maxTokens: { min: 1, max: 64000, default: 4096, field: 'max_tokens' },
        topP: { min: 0, max: 1, default: 1 },
      },
      contextWindow: 0,
      maxOutput: 4096,
    }
  },
  async listModels(config: ProviderConfig) {
    const runtime = resolveProviderRuntime('anthropic', config)
    const headers = { 'content-type': 'application/json', 'x-api-key': runtime.apiKey, 'anthropic-version': '2023-06-01', ...runtime.headers }
    const baseUrl = runtime.baseUrl || DEFAULT_BASE_URL
    return providerJSON('anthropic', `${baseUrl.replace(/\/$/, '')}/models`, { headers }, {}, parseAnthropicModelsResponse)
  },
  async chat(request: UnifiedRequest, config: ProviderConfig, context: ChatContext): Promise<UnifiedResponse> {
    const runtime = resolveProviderRuntime('anthropic', config)
    const headers = { 'content-type': 'application/json', 'x-api-key': runtime.apiKey, 'anthropic-version': '2023-06-01', ...runtime.headers }
    const baseUrl = runtime.baseUrl || DEFAULT_BASE_URL
    return providerJSON('anthropic', `${baseUrl.replace(/\/$/, '')}/messages`, {
      method: 'POST', headers, body: JSON.stringify(buildAnthropicRequestBody(request, context)),
    }, context, data => parseAnthropicResponse(data, context.model.id))
  },
  async *chatStream(request: UnifiedRequest, config: ProviderConfig, context: ChatContext): AsyncIterable<UnifiedStreamChunk> {
    const runtime = resolveProviderRuntime('anthropic', config)
    const headers = { 'content-type': 'application/json', 'x-api-key': runtime.apiKey, 'anthropic-version': '2023-06-01', ...runtime.headers }
    const baseUrl = runtime.baseUrl || DEFAULT_BASE_URL
    const state = createAnthropicStreamState(context.model.id)
    yield* providerStream('anthropic', `${baseUrl.replace(/\/$/, '')}/messages`, {
      method: 'POST', headers, body: JSON.stringify(buildAnthropicRequestBody({ ...request, stream: true }, context)),
    }, context, event => parseAnthropicStreamEvent(event as unknown as AnthropicStreamEvent, state), [runtime.apiKey], event => event.type === 'message_stop')
  },
}

export { anthropicModels, buildAnthropicRequestBody, parseAnthropicResponse, parseAnthropicStreamEvent }
