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

function combineSignals(signal: AbortSignal | undefined, timeoutMs: number | undefined): AbortSignal | undefined {
  if (!timeoutMs) return signal
  const timeout = AbortSignal.timeout(timeoutMs)
  if (!signal) return timeout
  return AbortSignal.any([signal, timeout])
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

async function providerHttpFailure(
  provider: string,
  response: Response,
  label: string,
): Promise<PolyLLMError> {
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
  async listModels(config: ProviderConfig): Promise<ProviderModelInfo[]> {
    const runtime = resolveProviderRuntime('openai', config)
    let response: Response
    try {
      response = await fetch(endpoint(runtime.baseUrl, '/models'), {
        headers: {
          authorization: `Bearer ${runtime.apiKey}`,
          ...runtime.headers,
        },
      })
    } catch (error) {
      throw providerTransportError('openai', error, 'OpenAI 模型列表获取', false)
    }
    if (!response.ok) throw await providerHttpFailure('openai', response, 'OpenAI 模型列表获取失败')
    return parseOpenAIModelsResponse((await response.json()) as JsonRecord)
  },
  async chat(
    request: UnifiedRequest,
    config: ProviderConfig,
    context: ChatContext,
  ): Promise<UnifiedResponse> {
    const runtime = resolveProviderRuntime('openai', config)
    const callOnce = async (): Promise<UnifiedResponse> => {
      let response: Response
      try {
        response = await fetch(endpoint(runtime.baseUrl, '/chat/completions'), {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${runtime.apiKey}`,
            ...runtime.headers,
          },
          body: JSON.stringify(buildOpenAIRequestBody(request, context)),
          signal: combineSignals(context.signal, context.timeoutMs) ?? null,
        })
      } catch (error) {
        throw providerFetchError('openai', error, context, 'OpenAI API 调用')
      }
      if (!response.ok) throw await providerHttpFailure('openai', response, 'OpenAI API 错误')
      const data = (await response.json()) as JsonRecord
      return parseOpenAIResponse(data, context.model.id)
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
    const runtime = resolveProviderRuntime('openai', config)
    let response: Response
    try {
      response = await fetch(`${runtime.baseUrl || DEFAULT_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${runtime.apiKey}`,
          ...runtime.headers,
        },
        body: JSON.stringify({ ...buildOpenAIRequestBody({ ...request, stream: true }, context) }),
        signal: combineSignals(context.signal, context.timeoutMs) ?? null,
      })
    } catch (error) {
      throw providerFetchError('openai', error, context, 'OpenAI API 流式调用')
    }
    if (!response.ok) throw await providerHttpFailure('openai', response, 'OpenAI API 错误')
    if (!response.body)
      throw new PolyLLMError('PROVIDER_ERROR', 'OpenAI API 未返回响应流', {
        provider: 'openai',
        category: 'connection',
        retryable: true,
      })

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
  openAIModels,
  buildOpenAIRequestBody,
  parseOpenAIModelsResponse,
  parseOpenAIResponse,
  parseOpenAIStreamEvent,
  type OpenAIStreamEvent,
}
