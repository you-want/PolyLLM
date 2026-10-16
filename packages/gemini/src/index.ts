import {
  classifyHttpStatus,
  extractErrorExcerpt,
  isRetryableCategory,
  parseRetryAfter,
  PolyLLMError,
  providerTransportError,
  resolveProviderRuntime,
  withRetries,
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
    let response: Response
    try {
      response = await fetch(`${baseUrl.replace(/\/$/, '')}/models`, {
        headers: { 'x-goog-api-key': runtime.apiKey, ...runtime.headers },
      })
    } catch (error) {
      throw providerTransportError('gemini', error, 'Gemini 模型列表获取', false)
    }
    if (!response.ok) throw await providerHttpFailure('gemini', response, 'Gemini 模型列表获取失败')
    return parseGeminiModelsResponse((await response.json()) as JsonRecord)
  },
  async chat(
    request: UnifiedRequest,
    config: ProviderConfig,
    context: ChatContext,
  ): Promise<UnifiedResponse> {
    const runtime = resolveProviderRuntime('gemini', config)
    const baseUrl = runtime.baseUrl.trim() || DEFAULT_BASE_URL
    const callOnce = async (): Promise<UnifiedResponse> => {
      let response: Response
      try {
        response = await fetch(endpoint(baseUrl, context.model.id, 'generateContent'), {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-goog-api-key': runtime.apiKey,
            ...runtime.headers,
          },
          body: JSON.stringify(buildGeminiRequestBody(request, context)),
          signal: combineSignals(context.signal, context.timeoutMs) ?? null,
        })
      } catch (error) {
        throw providerFetchError('gemini', error, context, 'Gemini API 调用')
      }
      if (!response.ok) throw await providerHttpFailure('gemini', response, 'Gemini API 错误')
      const data = (await response.json()) as JsonRecord
      return parseGeminiResponse(data, context.model.id)
    }
    if (!context.retries) return callOnce()
    const { result } = await withRetries(callOnce, {
      policy: context.retries,
      signal: context.signal,
      deadlineMs: context.timeoutMs,
    })
    return result
  },
  async *chatStream(
    request: UnifiedRequest,
    config: ProviderConfig,
    context: ChatContext,
  ): AsyncIterable<UnifiedStreamChunk> {
    const runtime = resolveProviderRuntime('gemini', config)
    const baseUrl = runtime.baseUrl.trim() || DEFAULT_BASE_URL
    let response: Response
    try {
      response = await fetch(endpoint(baseUrl, context.model.id, 'streamGenerateContent'), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': runtime.apiKey,
          ...runtime.headers,
        },
        body: JSON.stringify({ ...buildGeminiRequestBody({ ...request, stream: true }, context) }),
        signal: combineSignals(context.signal, context.timeoutMs) ?? null,
      })
    } catch (error) {
      throw providerFetchError('gemini', error, context, 'Gemini API 流式调用')
    }
    if (!response.ok) throw await providerHttpFailure('gemini', response, 'Gemini API 错误')
    if (!response.body)
      throw new PolyLLMError('PROVIDER_ERROR', 'Gemini API 未返回响应流', {
        provider: 'gemini',
        category: 'connection',
        retryable: true,
      })

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
