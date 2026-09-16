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
import {
  buildOpenAIRequestBody,
  parseOpenAIModelsResponse,
  parseOpenAIResponse,
  parseOpenAIStreamEvent,
  type OpenAIStreamEvent,
} from '@you-want/polyllm-openai'

function endpoint(baseUrl: string, path: string): string {
  if (!baseUrl.trim()) {
    throw new PolyLLMError('PROVIDER_ERROR', 'OpenAI-compatible 插件必须配置 baseUrl', {
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

async function readErrorMessage(response: Response): Promise<string> {
  const text = await response.text()
  return text || response.statusText
}

async function requestCompatible(
  request: UnifiedRequest,
  config: ProviderConfig,
  context: ChatContext,
): Promise<Response> {
  const runtime = resolveProviderRuntime('openai-compatible', config)
  return fetch(endpoint(runtime.baseUrl, '/chat/completions'), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${runtime.apiKey}`,
      ...runtime.headers,
    },
    body: JSON.stringify(buildOpenAIRequestBody(request, context)),
    signal: combineSignals(context.signal, context.timeoutMs) ?? null,
  })
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
    const response = await fetch(endpoint(runtime.baseUrl, '/models'), {
      headers: {
        authorization: `Bearer ${runtime.apiKey}`,
        ...runtime.headers,
      },
    })
    if (!response.ok) {
      throw new PolyLLMError(
        'PROVIDER_ERROR',
        `OpenAI-compatible 模型列表获取失败: ${response.status} ${await readErrorMessage(response)}`,
        { status: response.status, provider: 'openai-compatible' },
      )
    }
    return parseOpenAIModelsResponse((await response.json()) as JsonRecord)
  },
  async chat(
    request: UnifiedRequest,
    config: ProviderConfig,
    context: ChatContext,
  ): Promise<UnifiedResponse> {
    const response = await requestCompatible(request, config, context)
    if (!response.ok) {
      throw new PolyLLMError(
        'PROVIDER_ERROR',
        `OpenAI-compatible API 错误: ${response.status} ${await readErrorMessage(response)}`,
        { status: response.status, provider: 'openai-compatible' },
      )
    }
    const data = (await response.json()) as JsonRecord
    return parseOpenAIResponse(data, context.model.id)
  },
  async *chatStream(
    request: UnifiedRequest,
    config: ProviderConfig,
    context: ChatContext,
  ): AsyncIterable<UnifiedStreamChunk> {
    const response = await requestCompatible({ ...request, stream: true }, config, context)
    if (!response.ok) {
      throw new PolyLLMError(
        'PROVIDER_ERROR',
        `OpenAI-compatible API 错误: ${response.status} ${await readErrorMessage(response)}`,
        { status: response.status, provider: 'openai-compatible' },
      )
    }
    if (!response.body) throw new PolyLLMError('PROVIDER_ERROR', 'OpenAI-compatible API 未返回响应流')

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
