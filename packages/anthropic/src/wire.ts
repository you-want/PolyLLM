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

export type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'url'; url: string } }
  | { type: 'tool_use'; id: string; name: string; input: JsonRecord }
  | { type: 'tool_result'; tool_use_id: string; content: string }

export interface AnthropicWireMessage {
  role: 'user' | 'assistant'
  content: string | AnthropicContentBlock[]
}

export interface AnthropicWireRequest {
  model: string
  max_tokens: number
  messages: AnthropicWireMessage[]
  system?: string
  temperature?: number
  top_p?: number
  stream?: boolean
  tools?: {
    name: string
    description: string
    input_schema: JsonRecord
  }[]
}

interface AnthropicWireResponse {
  id?: string
  model?: string
  content?: AnthropicContentBlock[]
  stop_reason?: string | null
  usage?: {
    input_tokens?: number
    output_tokens?: number
  }
}

interface AnthropicModelsResponse {
  data?: {
    id?: string
    display_name?: string
    created_at?: string
  }[]
}

export interface AnthropicStreamEvent {
  type: string
  message?: {
    id?: string
    model?: string
    usage?: AnthropicWireResponse['usage']
  }
  index?: number
  content_block?: {
    type?: string
    id?: string
    name?: string
  }
  delta?: {
    type?: string
    text?: string
    partial_json?: string
    stop_reason?: string
  }
  usage?: AnthropicWireResponse['usage']
}

export interface AnthropicStreamState {
  id: string
  model: string
  toolIndexes: Map<number, number>
  nextToolIndex: number
}

function textContent(content: string | UnifiedContentPart[]): string {
  if (typeof content === 'string') return content
  return content
    .filter((part) => part.type === 'text')
    .map((part) => part.text ?? '')
    .join('')
}

function mapUserContent(content: string | UnifiedContentPart[]): AnthropicContentBlock[] {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : []
  return content.flatMap((part): AnthropicContentBlock[] => {
    if (part.type === 'text') return part.text ? [{ type: 'text', text: part.text }] : []
    return part.imageUrl ? [{ type: 'image', source: { type: 'url', url: part.imageUrl.url } }] : []
  })
}

function parseToolArguments(argumentsJson: string): JsonRecord {
  try {
    return JSON.parse(argumentsJson) as JsonRecord
  } catch {
    return {}
  }
}

function mapAssistantContent(message: UnifiedMessage): AnthropicContentBlock[] {
  const blocks: AnthropicContentBlock[] = []
  const text = textContent(message.content)
  if (text) blocks.push({ type: 'text', text })
  for (const call of message.toolCalls ?? []) {
    blocks.push({
      type: 'tool_use',
      id: call.id,
      name: call.function.name,
      input: parseToolArguments(call.function.arguments),
    })
  }
  return blocks
}

export function buildAnthropicRequestBody(request: UnifiedRequest, context: ChatContext): AnthropicWireRequest {
  const system = request.messages
    .filter((message) => message.role === 'system')
    .map((message) => textContent(message.content))
    .filter(Boolean)
    .join('\n\n')

  const messages: AnthropicWireMessage[] = []
  for (const message of request.messages) {
    if (message.role === 'system') continue
    if (message.role === 'tool') {
      messages.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: message.toolCallId ?? '',
            content: textContent(message.content),
          },
        ],
      })
      continue
    }
    messages.push({
      role: message.role,
      content: message.role === 'user' ? mapUserContent(message.content) : mapAssistantContent(message),
    })
  }

  const body: AnthropicWireRequest = {
    model: context.model.snapshot ?? context.model.id,
    max_tokens: request.maxTokens ?? context.model.params.maxTokens?.default ?? context.model.maxOutput,
    messages,
  }
  if (system) body.system = system
  if (request.temperature !== undefined) body.temperature = request.temperature
  if (request.topP !== undefined) body.top_p = request.topP
  if (request.stream) body.stream = true
  if (request.tools?.length) {
    body.tools = request.tools.map((tool: UnifiedTool) => ({
      name: tool.function.name,
      description: tool.function.description,
      input_schema: tool.function.parameters,
    }))
  }
  return body
}

export function mapAnthropicFinishReason(reason: string | null | undefined): FinishReason {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop'
    case 'max_tokens':
      return 'length'
    case 'tool_use':
      return 'tool_calls'
    case 'refusal':
      return 'content_filter'
    default:
      return 'other'
  }
}

export function parseAnthropicResponse(data: JsonRecord, fallbackModel: string): UnifiedResponse {
  const response = data as unknown as AnthropicWireResponse
  const text = (response.content ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
  const toolCalls: UnifiedToolCall[] = (response.content ?? []).flatMap((block) =>
    block.type === 'tool_use'
      ? [
          {
            id: block.id,
            type: 'function',
            function: { name: block.name, arguments: JSON.stringify(block.input) },
          },
        ]
      : [],
  )
  const promptTokens = response.usage?.input_tokens ?? 0
  const completionTokens = response.usage?.output_tokens ?? 0
  return {
    id: response.id ?? '',
    model: response.model ?? fallbackModel,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: text, ...(toolCalls.length ? { toolCalls } : {}) },
        finishReason: mapAnthropicFinishReason(response.stop_reason),
      },
    ],
    usage: {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
    },
    providerMetadata: data,
  }
}

export function createAnthropicStreamState(fallbackModel: string): AnthropicStreamState {
  return { id: '', model: fallbackModel, toolIndexes: new Map(), nextToolIndex: 0 }
}

export function parseAnthropicStreamEvent(
  event: AnthropicStreamEvent,
  state: AnthropicStreamState,
): UnifiedStreamChunk[] {
  if (event.type === 'message_start' && event.message) {
    state.id = event.message.id ?? state.id
    state.model = event.message.model ?? state.model
    return [
      {
        id: state.id,
        model: state.model,
        delta: { role: 'assistant' },
        usage: {
          promptTokens: event.message.usage?.input_tokens ?? 0,
          completionTokens: 0,
          totalTokens: event.message.usage?.input_tokens ?? 0,
        },
      },
    ]
  }

  if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
    const toolIndex = state.nextToolIndex++
    state.toolIndexes.set(event.index ?? 0, toolIndex)
    return [
      {
        id: state.id,
        model: state.model,
        delta: {
          toolCalls: [
            {
              id: event.content_block.id,
              type: 'function',
              function: { name: event.content_block.name ?? '', arguments: '' },
            },
          ],
        },
      },
    ]
  }

  if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
    return [{ id: state.id, model: state.model, delta: { content: event.delta.text ?? '' } }]
  }

  if (event.type === 'content_block_delta' && event.delta?.type === 'input_json_delta') {
    const toolIndex = state.toolIndexes.get(event.index ?? 0) ?? 0
    return [
      {
        id: state.id,
        model: state.model,
        delta: {
          toolCalls: [
            {
              function: { arguments: event.delta.partial_json ?? '' },
            },
          ],
        },
        providerMetadata: { toolIndex },
      },
    ]
  }

  if (event.type === 'message_delta') {
    const completionTokens = event.usage?.output_tokens ?? 0
    return [
      {
        id: state.id,
        model: state.model,
        delta: {},
        finishReason: mapAnthropicFinishReason(event.delta?.stop_reason),
        usage: {
          promptTokens: 0,
          completionTokens,
          totalTokens: completionTokens,
        },
      },
    ]
  }

  return []
}

export function parseAnthropicModelsResponse(data: JsonRecord): ProviderModelInfo[] {
  const response = data as unknown as AnthropicModelsResponse
  return (response.data ?? []).flatMap((model) => {
    if (!model.id) return []
    return [{
      id: model.id,
      displayName: model.display_name,
      createdAt: model.created_at,
    }]
  })
}
