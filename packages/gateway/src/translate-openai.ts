//! Inbound OpenAI-wire translation: OpenAI Chat Completions request JSON →
//! UnifiedRequest, and UnifiedResponse/UnifiedStreamChunk → OpenAI-wire JSON.
//! Mirrors `@you-want/polyllm-openai` conventions (snake_case wire fields).

import type {
  JsonRecord,
  UnifiedRequest,
  UnifiedResponse,
  UnifiedStreamChunk,
} from '@you-want/polyllm-core'
import { PolyLLMError } from '@you-want/polyllm-core'

interface OpenAIWireMessage {
  role?: string
  content?: string | OpenAIContentPart[] | null
  name?: string
  tool_call_id?: string
  tool_calls?: OpenAIWireToolCall[]
}

interface OpenAIContentPart {
  type?: string
  text?: string
  image_url?: { url?: string; detail?: string }
}

interface OpenAIWireToolCall {
  id?: string
  type?: string
  function?: { name?: string; arguments?: string }
}

function parseContent(content: OpenAIWireMessage['content']): UnifiedRequest['messages'][number]['content'] {
  if (typeof content === 'string' || content === null || content === undefined) {
    return content ?? ''
  }
  return content.map((part) => {
    if (part.type === 'image_url') {
      return { type: 'image_url' as const, imageUrl: { url: part.image_url?.url ?? '' } }
    }
    return { type: 'text' as const, text: part.text ?? '' }
  })
}

/** Inbound OpenAI Chat Completions request → UnifiedRequest. */
export function parseOpenAIRequest(body: JsonRecord): UnifiedRequest {
  const rawMessages = body.messages
  if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
    throw new PolyLLMError('INVALID_CONFIG', 'gateway: messages 不能为空', {
      endpoint: 'openai',
    })
  }
  const messages = (rawMessages as OpenAIWireMessage[]).map((message) => {
    const unified: UnifiedRequest['messages'][number] = {
      role: (message.role ?? 'user') as 'system' | 'user' | 'assistant' | 'tool',
      content: parseContent(message.content),
    }
    if (message.name !== undefined) unified.name = message.name
    if (message.tool_call_id !== undefined) unified.toolCallId = message.tool_call_id
    if (message.tool_calls?.length) {
      unified.toolCalls = message.tool_calls.map((call) => ({
        id: call.id ?? '',
        type: 'function' as const,
        function: {
          name: call.function?.name ?? '',
          arguments: call.function?.arguments ?? '{}',
        },
      }))
    }
    return unified
  })

  const tools = Array.isArray(body.tools)
    ? (body.tools as { function?: { name?: string; description?: string; parameters?: JsonRecord } }[]).map(
        (tool) => ({
          type: 'function' as const,
          function: {
            name: tool.function?.name ?? '',
            description: tool.function?.description ?? '',
            parameters: tool.function?.parameters ?? {},
          },
        }),
      )
    : undefined

  const responseFormat = body.response_format as { type?: string } | undefined
  const request: UnifiedRequest = {
    model: typeof body.model === 'string' ? body.model : '',
    messages,
    stream: body.stream === true,
    jsonMode: responseFormat?.type === 'json_object',
  }
  if (typeof body.temperature === 'number') request.temperature = body.temperature
  if (typeof body.top_p === 'number') request.topP = body.top_p
  if (typeof body.max_completion_tokens === 'number') request.maxTokens = body.max_completion_tokens
  else if (typeof body.max_tokens === 'number') request.maxTokens = body.max_tokens
  if (tools && tools.length > 0) request.tools = tools
  return request
}

function renderMessage(message: UnifiedResponse['choices'][number]['message']): JsonRecord {
  const rendered: JsonRecord = { role: message.role }
  const content = typeof message.content === 'string' ? message.content : null
  rendered.content = content
  if (message.toolCalls?.length) {
    rendered.tool_calls = message.toolCalls.map((call) => ({
      id: call.id,
      type: 'function',
      function: { name: call.function.name, arguments: call.function.arguments },
    }))
  }
  return rendered
}

/** UnifiedResponse → OpenAI Chat Completions response JSON. */
export function renderOpenAIResponse(response: UnifiedResponse): JsonRecord {
  const choice = response.choices[0]
  return {
    id: response.id,
    object: 'chat.completion',
    model: response.model,
    choices: [
      {
        index: choice.index,
        message: renderMessage(choice.message),
        finish_reason: choice.finishReason === 'other' ? 'stop' : choice.finishReason,
      },
    ],
    usage: {
      prompt_tokens: response.usage.promptTokens,
      completion_tokens: response.usage.completionTokens,
      total_tokens: response.usage.totalTokens,
    },
  }
}

/** UnifiedStreamChunk → OpenAI chunk JSON (transport writes `data:` framing). */
export function renderOpenAIStreamChunk(chunk: UnifiedStreamChunk): JsonRecord {
  const toolCalls = chunk.delta.toolCalls?.map((call, index) => ({
    index: call.index ?? index,
    ...(call.id !== undefined ? { id: call.id } : {}),
    ...(call.function?.name !== undefined || call.function?.arguments !== undefined
      ? {
          function: {
            ...(call.function?.name !== undefined ? { name: call.function.name } : {}),
            ...(call.function?.arguments !== undefined ? { arguments: call.function.arguments } : {}),
          },
        }
      : {}),
  }))
  const delta: JsonRecord = {}
  if (chunk.delta.role !== undefined) delta.role = chunk.delta.role
  if (chunk.delta.content !== undefined) delta.content = chunk.delta.content
  if (toolCalls !== undefined && toolCalls.length > 0) delta.tool_calls = toolCalls

  const rendered: JsonRecord = {
    id: chunk.id,
    object: 'chat.completion.chunk',
    model: chunk.model,
    choices: [
      {
        index: 0,
        delta,
        ...(chunk.finishReason !== undefined ? { finish_reason: chunk.finishReason === 'other' ? 'stop' : chunk.finishReason } : {}),
      },
    ],
  }
  if (chunk.usage !== undefined) {
    rendered.usage = {
      prompt_tokens: chunk.usage.promptTokens,
      completion_tokens: chunk.usage.completionTokens,
      total_tokens: chunk.usage.totalTokens,
    }
  }
  return rendered
}
