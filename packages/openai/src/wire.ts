import type {
  ChatContext,
  FinishReason,
  JsonRecord,
  UnifiedContentPart,
  UnifiedMessage,
  UnifiedRequest,
  UnifiedResponse,
  UnifiedStreamChunk,
  UnifiedTool,
  UnifiedToolCall,
  StreamToolCall,
  ProviderModelInfo,
} from '@you-want/polyllm-core'

export interface OpenAIContentPart {
  type: 'text' | 'image_url'
  text?: string
  image_url?: { url: string; detail?: string | undefined }
}

export interface OpenAIWireToolCall {
  id?: string
  index?: number
  type?: string
  function?: {
    name?: string
    arguments?: string
  }
}

export interface OpenAIWireMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | OpenAIContentPart[] | null
  name?: string
  tool_call_id?: string
  tool_calls?: OpenAIWireToolCall[]
}

export interface OpenAIWireRequest {
  model: string
  messages: OpenAIWireMessage[]
  temperature?: number
  max_completion_tokens?: number
  max_tokens?: number
  top_p?: number
  stream?: boolean
  stream_options?: { include_usage: boolean }
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

interface OpenAIWireResponse {
  id?: string
  model?: string
  choices?: {
    index?: number
    message?: {
      role?: string
      content?: string | null
      tool_calls?: OpenAIWireToolCall[]
    }
    finish_reason?: string | null
  }[]
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
  }
}

interface OpenAIModelsResponse {
  data?: {
    id?: string
    owned_by?: string
    created?: number
  }[]
}

export interface OpenAIStreamEvent {
  id?: string
  model?: string
  choices?: {
    delta?: {
      role?: string
      content?: string | null
      tool_calls?: OpenAIWireToolCall[]
    }
    finish_reason?: string | null
  }[]
  usage?: OpenAIWireResponse['usage']
}

function mapContent(content: string | UnifiedContentPart[]): string | OpenAIContentPart[] {
  if (typeof content === 'string') return content
  return content.map((part) =>
    part.type === 'text'
      ? { type: 'text', text: part.text ?? '' }
      : { type: 'image_url', image_url: { url: part.imageUrl?.url ?? '', detail: part.imageUrl?.detail } },
  )
}

function mapToolCall(call: UnifiedToolCall): OpenAIWireToolCall {
  return {
    id: call.id,
    type: 'function',
    function: { name: call.function.name, arguments: call.function.arguments },
  }
}

export function buildOpenAIRequestBody(request: UnifiedRequest, context: ChatContext): OpenAIWireRequest {
  const messages: OpenAIWireMessage[] = request.messages.map((message: UnifiedMessage) => {
    const wire: OpenAIWireMessage = {
      role: message.role,
      content: mapContent(message.content),
    }
    if (message.name !== undefined) wire.name = message.name
    if (message.toolCallId !== undefined) wire.tool_call_id = message.toolCallId
    if (message.toolCalls?.length) wire.tool_calls = message.toolCalls.map(mapToolCall)
    return wire
  })

  const body: OpenAIWireRequest = {
    model: context.model.snapshot ?? context.model.id,
    messages,
  }
  if (request.temperature !== undefined) body.temperature = request.temperature
  if (request.maxTokens !== undefined) {
    const field = context.model.params.maxTokens?.field
    if (field === 'max_tokens') body.max_tokens = request.maxTokens
    else body.max_completion_tokens = request.maxTokens
  }
  if (request.topP !== undefined) body.top_p = request.topP
  if (request.stream) {
    body.stream = true
    body.stream_options = { include_usage: true }
  }
  if (request.jsonMode) body.response_format = { type: 'json_object' }
  if (request.tools?.length) {
    body.tools = request.tools.map((tool: UnifiedTool) => ({
      type: 'function',
      function: tool.function,
    }))
  }
  return body
}

export function mapOpenAIFinishReason(reason: string | null | undefined): FinishReason {
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

export function parseOpenAIResponse(data: JsonRecord, fallbackModel: string): UnifiedResponse {
  const response = data as unknown as OpenAIWireResponse
  const choice = response.choices?.[0]
  const message = choice?.message
  const assistant: UnifiedMessage = {
    role: 'assistant',
    content: message?.content ?? '',
  }
  if (message?.tool_calls?.length) {
    assistant.toolCalls = message.tool_calls.map((call) => ({
      id: call.id ?? '',
      type: 'function',
      function: {
        name: call.function?.name ?? '',
        arguments: call.function?.arguments ?? '{}',
      },
    }))
  }
  return {
    id: response.id ?? '',
    model: response.model ?? fallbackModel,
    choices: [
      {
        index: choice?.index ?? 0,
        message: assistant,
        finishReason: mapOpenAIFinishReason(choice?.finish_reason),
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

export function parseOpenAIStreamEvent(event: OpenAIStreamEvent, fallbackModel: string): UnifiedStreamChunk {
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
        function: {
          name: call.function?.name,
          arguments: call.function?.arguments,
        },
      })),
    },
    usage: event.usage
      ? {
          promptTokens: event.usage.prompt_tokens ?? 0,
          completionTokens: event.usage.completion_tokens ?? 0,
          totalTokens: event.usage.total_tokens ?? 0,
        }
      : undefined,
    finishReason: choice?.finish_reason ? mapOpenAIFinishReason(choice.finish_reason) : undefined,
  }
}

export function parseOpenAIModelsResponse(data: JsonRecord): ProviderModelInfo[] {
  const response = data as unknown as OpenAIModelsResponse
  return (response.data ?? []).flatMap((model) => {
    if (!model.id) return []
    return [{
      id: model.id,
      ownedBy: model.owned_by,
      createdAt: model.created,
    }]
  })
}
