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

function combineSignals(signal: AbortSignal | undefined, timeoutMs: number | undefined): AbortSignal | undefined {
  if (!timeoutMs) return signal
  const timeout = AbortSignal.timeout(timeoutMs)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

async function readErrorMessage(response: Response): Promise<string> {
  const text = await response.text()
  return text || response.statusText
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
  async listModels(config: ProviderConfig): Promise<ProviderModelInfo[]> {
    const runtime = resolveProviderRuntime('gemini', config)
    const baseUrl = runtime.baseUrl.trim() || DEFAULT_BASE_URL
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/models`, {
      headers: { 'x-goog-api-key': runtime.apiKey, ...runtime.headers },
    })
    if (!response.ok) {
      throw new PolyLLMError(
        'PROVIDER_ERROR',
        `Gemini 模型列表获取失败: ${response.status} ${await readErrorMessage(response)}`,
        { status: response.status, provider: 'gemini' },
      )
    }
    return parseGeminiModelsResponse((await response.json()) as JsonRecord)
  },
  async chat(
    request: UnifiedRequest,
    config: ProviderConfig,
    context: ChatContext,
  ): Promise<UnifiedResponse> {
    const runtime = resolveProviderRuntime('gemini', config)
    const baseUrl = runtime.baseUrl.trim() || DEFAULT_BASE_URL
    const response = await fetch(endpoint(baseUrl, context.model.id, 'generateContent'), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': runtime.apiKey,
        ...runtime.headers,
      },
      body: JSON.stringify(buildGeminiRequestBody(request, context)),
      signal: combineSignals(context.signal, context.timeoutMs) ?? null,
    })
    if (!response.ok) {
      throw new PolyLLMError(
        'PROVIDER_ERROR',
        `Gemini API 错误: ${response.status} ${await readErrorMessage(response)}`,
        { status: response.status, provider: 'gemini' },
      )
    }
    const data = (await response.json()) as JsonRecord
    return parseGeminiResponse(data, context.model.id)
  },
  async *chatStream(
    request: UnifiedRequest,
    config: ProviderConfig,
    context: ChatContext,
  ): AsyncIterable<UnifiedStreamChunk> {
    const runtime = resolveProviderRuntime('gemini', config)
    const baseUrl = runtime.baseUrl.trim() || DEFAULT_BASE_URL
    const response = await fetch(endpoint(baseUrl, context.model.id, 'streamGenerateContent'), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': runtime.apiKey,
        ...runtime.headers,
      },
      body: JSON.stringify({ ...buildGeminiRequestBody({ ...request, stream: true }, context) }),
      signal: combineSignals(context.signal, context.timeoutMs) ?? null,
    })
    if (!response.ok) {
      throw new PolyLLMError(
        'PROVIDER_ERROR',
        `Gemini API 错误: ${response.status} ${await readErrorMessage(response)}`,
        { status: response.status, provider: 'gemini' },
      )
    }
    if (!response.body) throw new PolyLLMError('PROVIDER_ERROR', 'Gemini API 未返回响应流')

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    const state = createGeminiStreamState()
    const handleLine = (line: string): UnifiedStreamChunk[] => {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) return []
      const payload = trimmed.slice('data:'.length).trim()
      if (!payload) return []
      return parseGeminiStreamEvent(JSON.parse(payload) as JsonRecord, state, context.model.id)
    }
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        for (const chunk of handleLine(line)) yield chunk
      }
    }
    buffer += decoder.decode()
    if (buffer.trim()) {
      for (const chunk of handleLine(buffer)) yield chunk
    }
  },
}

export { geminiModels }
