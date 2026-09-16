import type {
  ChatContext,
  FinishReason,
  JsonRecord,
  UnifiedMessage,
  UnifiedRequest,
  UnifiedResponse,
  UnifiedStreamChunk,
  UnifiedTool,
  UnifiedToolCall,
  StreamToolCall,
  ProviderModelInfo,
} from '@you-want/polyllm-core'

export interface DeepSeekWireMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  name?: string
  tool_call_id?: string
  tool_calls?: {
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }[]
}

export interface DeepSeekWireRequest {
  model: string
  messages: DeepSeekWireMessage[]
  temperature?: number
  max_tokens?: number
  top_p?: number
  stream?: boolean
  response_format?: { type: 'json_object' }
  tools?: {
    type: 'function'
    function: {
      name: string
      description: string
      parameters: JsonRecord
    }
  }[]
}

interface DeepSeekWireResponse {
  id?: string
  model?: string
  choices?: {
    index?: number
    message?: {
      role?: string
      content?: string | null
      tool_calls?: {
        id?: string
        type?: string
        function?: { name?: string; arguments?: string }
      }[]
    }
    finish_reason?: string | null
  }[]
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
  }
}

interface DeepSeekModelsResponse {
  data?: {
    id?: string
    owned_by?: string
    created?: number
  }[]
}

export interface DeepSeekStreamEvent {
  id?: string
  model?: string
  choices?: {
    delta?: {
      role?: string
      content?: string | null
      tool_calls?: {
        id?: string
        index?: number
        type?: string
        function?: { name?: string; arguments?: string }
      }[]
    }
    finish_reason?: string | null
  }[]
  usage?: DeepSeekWireResponse['usage']
}

export function buildDeepSeekRequestBody(request: UnifiedRequest, context: ChatContext): DeepSeekWireRequest {
  const messages = request.messages.map((message: UnifiedMessage): DeepSeekWireMessage => {
    const content = typeof message.content === 'string'
      ? message.content
      : message.content.map((part) => (part.type === 'text' ? part.text ?? '' : '')).join('')
    const wire: DeepSeekWireMessage = { role: message.role, content }
    if (message.name !== undefined) wire.name = message.name
    if (message.toolCallId !== undefined) wire.tool_call_id = message.toolCallId
    if (message.toolCalls?.length) {
      wire.tool_calls = message.toolCalls.map((call: UnifiedToolCall) => ({
        id: call.id,
        type: 'function',
        function: { name: call.function.name, arguments: call.function.arguments },
      }))
    }
    return wire
  })

  const body: DeepSeekWireRequest = {
    model: context.model.snapshot ?? context.model.id,
    messages,
  }
  if (request.temperature !== undefined) body.temperature = request.temperature
  if (request.maxTokens !== undefined) body.max_tokens = request.maxTokens
  if (request.topP !== undefined) body.top_p = request.topP
  if (request.stream) body.stream = true
  if (request.jsonMode) body.response_format = { type: 'json_object' }
  if (request.tools?.length) {
    body.tools = request.tools.map((tool: UnifiedTool) => ({
      type: 'function',
      function: tool.function,
    }))
  }
  return body
}

function mapFinishReason(reason: string | null | undefined): FinishReason {
  switch (reason) {
    case 'stop':
      return 'stop'
    case 'length':
      return 'length'
    case 'tool_calls':
      return 'tool_calls'
    case 'content_filter':
      return 'content_filter'
    default:
      return 'other'
  }
}

export function parseDeepSeekResponse(data: JsonRecord, fallbackModel: string): UnifiedResponse {
  const response = data as unknown as DeepSeekWireResponse
  const choice = response.choices?.[0]
  const message = choice?.message
  const assistant: UnifiedMessage = { role: 'assistant', content: message?.content ?? '' }
  if (message?.tool_calls?.length) {
    assistant.toolCalls = message.tool_calls.map((call) => ({
      id: call.id ?? '',
      type: 'function',
      function: { name: call.function?.name ?? '', arguments: call.function?.arguments ?? '{}' },
    }))
  }
  return {
    id: response.id ?? '',
    model: response.model ?? fallbackModel,
    choices: [
      {
        index: choice?.index ?? 0,
        message: assistant,
        finishReason: mapFinishReason(choice?.finish_reason),
      },
    ],
    usage: {
      promptTokens: response.usage?.prompt_tokens ?? 0,
      completionTokens: response.usage?.completion_tokens ?? 0,
      totalTokens: response.usage?.total_tokens ?? 0,
    },
    providerMetadata: data,
  }
}

export function parseDeepSeekStreamEvent(event: DeepSeekStreamEvent, fallbackModel: string): UnifiedStreamChunk {
  const choice = event.choices?.[0]
  const delta = choice?.delta
  return {
    id: event.id ?? '',
    model: event.model ?? fallbackModel,
    delta: {
      role: delta?.role === 'assistant' ? 'assistant' : undefined,
      content: delta?.content ?? undefined,
      toolCalls: delta?.tool_calls?.map((call): StreamToolCall => ({
        id: call.id,
        type: call.type === 'function' ? 'function' : undefined,
        function: { name: call.function?.name, arguments: call.function?.arguments },
      })),
    },
    usage: event.usage
      ? {
          promptTokens: event.usage.prompt_tokens ?? 0,
          completionTokens: event.usage.completion_tokens ?? 0,
          totalTokens: event.usage.total_tokens ?? 0,
        }
      : undefined,
    finishReason: choice?.finish_reason ? mapFinishReason(choice.finish_reason) : undefined,
  }
}

export function parseDeepSeekModelsResponse(data: JsonRecord): ProviderModelInfo[] {
  const response = data as unknown as DeepSeekModelsResponse
  return (response.data ?? []).flatMap((model) => {
    if (!model.id) return []
    return [{
      id: model.id,
      ownedBy: model.owned_by,
      createdAt: model.created,
    }]
  })
}
