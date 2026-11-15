//! Inbound Anthropic-wire translation: /v1/messages request JSON →
//! UnifiedRequest, and UnifiedResponse/UnifiedStreamChunk → Anthropic
//! Messages-format JSON + SSE events. This is the magpie-style bridge that
//! lets Anthropic-protocol clients (Claude Code 等) talk to any backend the
//! gateway can reach. Mirrors `@you-want/polyllm-anthropic` conventions.

import type {
  JsonRecord,
  UnifiedRequest,
  UnifiedResponse,
  UnifiedStreamChunk,
} from '@you-want/polyllm-core'
import { PolyLLMError } from '@you-want/polyllm-core'

interface AnthropicContentBlock {
  type?: string
  text?: string
  source?: { type?: string; url?: string }
  id?: string
  name?: string
  input?: JsonRecord
  tool_use_id?: string
  content?: string
}

interface AnthropicWireMessage {
  role?: string
  content?: string | AnthropicContentBlock[]
}

/** Inbound Anthropic Messages request → UnifiedRequest. */
export function parseAnthropicRequest(body: JsonRecord): UnifiedRequest {
  const messages: UnifiedRequest['messages'] = []

  const system = body.system
  if (typeof system === 'string' && system.length > 0) {
    messages.push({ role: 'system', content: system })
  } else if (Array.isArray(system)) {
    const text = (system as AnthropicContentBlock[])
      .map((block) => block.text ?? '')
      .filter(Boolean)
      .join('\n\n')
    if (text) messages.push({ role: 'system', content: text })
  }

  const rawMessages = body.messages
  if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
    throw new PolyLLMError('INVALID_CONFIG', 'gateway: messages 不能为空', {
      endpoint: 'anthropic',
    })
  }
  type MessagePart = Extract<UnifiedRequest['messages'][number]['content'], unknown[]>[number]

  for (const raw of rawMessages as AnthropicWireMessage[]) {
    const role = raw.role === 'assistant' ? 'assistant' : 'user'
    if (typeof raw.content === 'string' || raw.content === undefined) {
      messages.push({ role, content: raw.content ?? '' })
      continue
    }
    // Structured content: text/image blocks stay with the role; tool_result
    // blocks become unified tool messages regardless of their container role.
    const parts: MessagePart[] = []
    const toolCalls: Extract<UnifiedRequest['messages'][number]['toolCalls'], unknown[]> = []
    const toolMessages: UnifiedRequest['messages'] = []
    for (const block of raw.content) {
      if (block.type === 'text' && block.text) {
        parts.push({ type: 'text', text: block.text })
      } else if (block.type === 'image' && block.source?.url) {
        parts.push({ type: 'image_url', imageUrl: { url: block.source.url } })
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id ?? '',
          type: 'function' as const,
          function: { name: block.name ?? '', arguments: JSON.stringify(block.input ?? {}) },
        })
      } else if (block.type === 'tool_result') {
        toolMessages.push({
          role: 'tool',
          content: block.content ?? '',
          toolCallId: block.tool_use_id ?? '',
        })
      }
    }
    const unified: UnifiedRequest['messages'][number] = { role, content: '' }
    if (toolCalls.length > 0) unified.toolCalls = toolCalls
    else if (parts.length > 0) unified.content = parts
    else unified.content = ''
    messages.push(unified)
    messages.push(...toolMessages)
  }

  const tools = Array.isArray(body.tools)
    ? (body.tools as { name?: string; description?: string; input_schema?: JsonRecord }[]).map((tool) => ({
        type: 'function' as const,
        function: {
          name: tool.name ?? '',
          description: tool.description ?? '',
          parameters: tool.input_schema ?? {},
        },
      }))
    : undefined

  if (typeof body.max_tokens !== 'number') {
    throw new PolyLLMError('INVALID_CONFIG', 'gateway: Anthropic 请求需要数值 max_tokens', {
      endpoint: 'anthropic',
      parameter: 'max_tokens',
    })
  }

  const request: UnifiedRequest = {
    model: typeof body.model === 'string' ? body.model : '',
    messages,
    maxTokens: body.max_tokens,
    stream: body.stream === true,
  }
  if (typeof body.temperature === 'number') request.temperature = body.temperature
  if (typeof body.top_p === 'number') request.topP = body.top_p
  if (tools && tools.length > 0) request.tools = tools
  return request
}

const REVERSE_FINISH: Record<string, string> = {
  stop: 'end_turn',
  length: 'max_tokens',
  tool_calls: 'tool_use',
  content_filter: 'refusal',
  other: 'end_turn',
}

function contentBlocks(message: UnifiedResponse['choices'][number]['message']): JsonRecord[] {
  const blocks: JsonRecord[] = []
  const text = typeof message.content === 'string' ? message.content : ''
  if (text) blocks.push({ type: 'text', text })
  for (const call of message.toolCalls ?? []) {
    let input: JsonRecord = {}
    try {
      const parsed: unknown = JSON.parse(call.function.arguments)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) input = parsed as JsonRecord
    } catch {
      input = {}
    }
    blocks.push({ type: 'tool_use', id: call.id, name: call.function.name, input })
  }
  return blocks
}

/** UnifiedResponse → Anthropic Messages response JSON. */
export function renderAnthropicResponse(response: UnifiedResponse): JsonRecord {
  const choice = response.choices[0]
  return {
    id: response.id,
    model: response.model,
    content: contentBlocks(choice.message),
    stop_reason: REVERSE_FINISH[choice.finishReason] ?? 'end_turn',
    usage: {
      input_tokens: response.usage.promptTokens,
      output_tokens: response.usage.completionTokens,
    },
  }
}

/** Anthropic SSE render state (mirrors the official event sequence). */
export interface AnthropicRenderState {
  started: boolean
  textBlockOpen: boolean
  toolBlocks: Map<number, { id: string; name: string }>
  nextBlockIndex: number
}

export function createAnthropicRenderState(): AnthropicRenderState {
  return { started: false, textBlockOpen: false, toolBlocks: new Map(), nextBlockIndex: 0 }
}

export interface AnthropicSseEvent {
  event: string
  data: JsonRecord
}

/** UnifiedStreamChunk → zero or more Anthropic SSE events. The caller writes
 *  `event: <event>\ndata: <json>\n\n` per item and appends message_stop at the
 *  end of the stream. */
export function renderAnthropicStreamChunk(
  chunk: UnifiedStreamChunk,
  state: AnthropicRenderState,
): AnthropicSseEvent[] {
  const events: AnthropicSseEvent[] = []
  if (!state.started) {
    state.started = true
    events.push({
      event: 'message_start',
      data: {
        type: 'message_start',
        message: {
          id: chunk.id,
          model: chunk.model,
          role: 'assistant',
          usage: { input_tokens: chunk.usage?.promptTokens ?? 0 },
        },
      },
    })
  }
  if (chunk.delta.content !== undefined && chunk.delta.content !== '') {
    if (!state.textBlockOpen) {
      state.textBlockOpen = true
      events.push({
        event: 'content_block_start',
        data: { type: 'content_block_start', index: state.nextBlockIndex, content_block: { type: 'text', text: '' } },
      })
      state.nextBlockIndex += 1
    }
    events.push({
      event: 'content_block_delta',
      data: {
        type: 'content_block_delta',
        index: state.nextBlockIndex - 1,
        delta: { type: 'text_delta', text: chunk.delta.content },
      },
    })
  }
  for (const call of chunk.delta.toolCalls ?? []) {
    const logicalIndex = call.index ?? 0
    const existing = state.toolBlocks.get(logicalIndex)
    if (!existing && call.id !== undefined && call.function?.name !== undefined) {
      const blockIndex = state.nextBlockIndex
      state.nextBlockIndex += 1
      state.toolBlocks.set(logicalIndex, { id: call.id, name: call.function.name })
      events.push({
        event: 'content_block_start',
        data: {
          type: 'content_block_start',
          index: blockIndex,
          content_block: { type: 'tool_use', id: call.id, name: call.function.name },
        },
      })
      const args = call.function.arguments ?? ''
      if (args) {
        events.push({
          event: 'content_block_delta',
          data: {
            type: 'content_block_delta',
            index: blockIndex,
            delta: { type: 'input_json_delta', partial_json: args },
          },
        })
      }
    } else if (existing && call.function?.arguments !== undefined) {
      const blockIndex = state.nextBlockIndex - 1
      events.push({
        event: 'content_block_delta',
        data: {
          type: 'content_block_delta',
          index: blockIndex,
          delta: { type: 'input_json_delta', partial_json: call.function.arguments },
        },
      })
    }
  }
  if (chunk.finishReason !== undefined) {
    if (state.textBlockOpen) {
      events.push({
        event: 'content_block_stop',
        data: { type: 'content_block_stop', index: state.nextBlockIndex - 1 },
      })
    }
    events.push({
      event: 'message_delta',
      data: {
        type: 'message_delta',
        delta: { stop_reason: REVERSE_FINISH[chunk.finishReason] ?? 'end_turn' },
        usage: { output_tokens: chunk.usage?.completionTokens ?? 0 },
      },
    })
  }
  return events
}

export const ANTHROPIC_MESSAGE_STOP: AnthropicSseEvent = {
  event: 'message_stop',
  data: { type: 'message_stop' },
}

/** PolyLLMError → Anthropic error JSON. */
export function renderAnthropicError(error: PolyLLMError): JsonRecord {
  return {
    type: 'error',
    error: { type: 'api_error', message: error.message },
  }
}
