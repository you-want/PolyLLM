import {
  PolyLLMError,
  resolveProviderRuntime,
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

function combineSignals(signal: AbortSignal | undefined, timeoutMs: number | undefined): AbortSignal | undefined {
  if (!timeoutMs) return signal
  const timeout = AbortSignal.timeout(timeoutMs)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

async function readErrorMessage(response: Response): Promise<string> {
  const text = await response.text()
  return text || response.statusText
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
  async listModels(config: ProviderConfig): Promise<ProviderModelInfo[]> {
    const runtime = resolveProviderRuntime('deepseek', config)
    const response = await fetch(endpoint(runtime.baseUrl, '/models'), {
      headers: {
        authorization: `Bearer ${runtime.apiKey}`,
        ...runtime.headers,
      },
    })
    if (!response.ok) {
      throw new PolyLLMError(
        'PROVIDER_ERROR',
        `DeepSeek 模型列表获取失败: ${response.status} ${await readErrorMessage(response)}`,
        { status: response.status, provider: 'deepseek' },
      )
    }
    return parseDeepSeekModelsResponse((await response.json()) as JsonRecord)
  },
  async chat(
    request: UnifiedRequest,
    config: ProviderConfig,
    context: ChatContext,
  ): Promise<UnifiedResponse> {
    const runtime = resolveProviderRuntime('deepseek', config)
    const response = await fetch(endpoint(runtime.baseUrl, '/chat/completions'), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${runtime.apiKey}`,
        ...runtime.headers,
      },
      body: JSON.stringify(buildDeepSeekRequestBody(request, context)),
      signal: combineSignals(context.signal, context.timeoutMs) ?? null,
    })
    if (!response.ok) {
      throw new PolyLLMError(
        'PROVIDER_ERROR',
        `DeepSeek API 错误: ${response.status} ${await readErrorMessage(response)}`,
        { status: response.status, provider: 'deepseek' },
      )
    }
    const data = (await response.json()) as JsonRecord
    return parseDeepSeekResponse(data, context.model.id)
  },
  async *chatStream(
    request: UnifiedRequest,
    config: ProviderConfig,
    context: ChatContext,
  ): AsyncIterable<UnifiedStreamChunk> {
    const runtime = resolveProviderRuntime('deepseek', config)
    const response = await fetch(`${runtime.baseUrl || DEFAULT_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${runtime.apiKey}`,
        ...runtime.headers,
      },
      body: JSON.stringify(buildDeepSeekRequestBody({ ...request, stream: true }, context)),
      signal: combineSignals(context.signal, context.timeoutMs) ?? null,
    })
    if (!response.ok) {
      throw new PolyLLMError(
        'PROVIDER_ERROR',
        `DeepSeek API 错误: ${response.status} ${await readErrorMessage(response)}`,
        { status: response.status, provider: 'deepseek' },
      )
    }
    if (!response.body) throw new PolyLLMError('PROVIDER_ERROR', 'DeepSeek API 未返回响应流')
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
        yield parseDeepSeekStreamEvent(JSON.parse(payload) as DeepSeekStreamEvent, context.model.id)
      }
    }
  },
}

export { deepSeekModels, buildDeepSeekRequestBody, parseDeepSeekResponse, parseDeepSeekStreamEvent }
