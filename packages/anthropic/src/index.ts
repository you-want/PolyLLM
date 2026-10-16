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

async function requestAnthropic(
  request: UnifiedRequest,
  config: ProviderConfig,
  context: ChatContext,
): Promise<Response> {
  const runtime = resolveProviderRuntime('anthropic', config)
  try {
    return await fetch(endpoint(runtime.baseUrl, '/messages'), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': runtime.apiKey,
        'anthropic-version': '2023-06-01',
        ...runtime.headers,
      },
      body: JSON.stringify(buildAnthropicRequestBody(request, context)),
      signal: combineSignals(context.signal, context.timeoutMs) ?? null,
    })
  } catch (error) {
    throw providerFetchError('anthropic', error, context, 'Anthropic API 调用')
  }
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
  async listModels(config: ProviderConfig): Promise<ProviderModelInfo[]> {
    const runtime = resolveProviderRuntime('anthropic', config)
    let response: Response
    try {
      response = await fetch(endpoint(runtime.baseUrl, '/models'), {
        headers: {
          'x-api-key': runtime.apiKey,
          'anthropic-version': '2023-06-01',
          ...runtime.headers,
        },
      })
    } catch (error) {
      throw providerTransportError('anthropic', error, 'Anthropic 模型列表获取', false)
    }
    if (!response.ok) throw await providerHttpFailure('anthropic', response, 'Anthropic 模型列表获取失败')
    return parseAnthropicModelsResponse((await response.json()) as JsonRecord)
  },
  async chat(
    request: UnifiedRequest,
    config: ProviderConfig,
    context: ChatContext,
  ): Promise<UnifiedResponse> {
    const callOnce = async (): Promise<UnifiedResponse> => {
      const response = await requestAnthropic(request, config, context)
      if (!response.ok) throw await providerHttpFailure('anthropic', response, 'Anthropic API 错误')
      const data = (await response.json()) as JsonRecord
      return parseAnthropicResponse(data, context.model.id)
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
    const response = await requestAnthropic({ ...request, stream: true }, config, context)
    if (!response.ok) throw await providerHttpFailure('anthropic', response, 'Anthropic API 错误')
    if (!response.body)
      throw new PolyLLMError('PROVIDER_ERROR', 'Anthropic API 未返回响应流', {
        provider: 'anthropic',
        category: 'connection',
        retryable: true,
      })

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    const state = createAnthropicStreamState(context.model.id)
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
        for (const chunk of parseAnthropicStreamEvent(JSON.parse(payload) as AnthropicStreamEvent, state)) {
          yield chunk
        }
      }
    }
  },
}

export { anthropicModels, buildAnthropicRequestBody, parseAnthropicResponse, parseAnthropicStreamEvent }
