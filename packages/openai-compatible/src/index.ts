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

async function requestCompatible(
  request: UnifiedRequest,
  config: ProviderConfig,
  context: ChatContext,
): Promise<Response> {
  const runtime = resolveProviderRuntime('openai-compatible', config)
  try {
    return await fetch(endpoint(runtime.baseUrl, '/chat/completions'), {
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
    throw providerFetchError('openai-compatible', error, context, 'OpenAI-compatible API 调用')
  }
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
  async listModels(config: ProviderConfig): Promise<ProviderModelInfo[]> {
    const runtime = resolveProviderRuntime('openai-compatible', config)
    let response: Response
    try {
      response = await fetch(endpoint(runtime.baseUrl, '/models'), {
        headers: {
          authorization: `Bearer ${runtime.apiKey}`,
          ...runtime.headers,
        },
      })
    } catch (error) {
      throw providerTransportError('openai-compatible', error, 'OpenAI-compatible 模型列表获取', false)
    }
    if (!response.ok) throw await providerHttpFailure('openai-compatible', response, 'OpenAI-compatible 模型列表获取失败')
    return parseOpenAIModelsResponse((await response.json()) as JsonRecord)
  },
  async chat(
    request: UnifiedRequest,
    config: ProviderConfig,
    context: ChatContext,
  ): Promise<UnifiedResponse> {
    const callOnce = async (): Promise<UnifiedResponse> => {
      const response = await requestCompatible(request, config, context)
      if (!response.ok) throw await providerHttpFailure('openai-compatible', response, 'OpenAI-compatible API 错误')
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
    const response = await requestCompatible({ ...request, stream: true }, config, context)
    if (!response.ok) throw await providerHttpFailure('openai-compatible', response, 'OpenAI-compatible API 错误')
    if (!response.body)
      throw new PolyLLMError('PROVIDER_ERROR', 'OpenAI-compatible API 未返回响应流', {
        provider: 'openai-compatible',
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

export { openaiCompatiblePresets, type OpenAICompatiblePreset } from './presets.js'
