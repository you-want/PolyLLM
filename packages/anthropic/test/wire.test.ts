import { describe, expect, it } from 'vitest'
import type { ChatContext } from '@you-want/polyllm-core'
import { anthropicModels } from '../src/models.ts'
import {
  buildAnthropicRequestBody,
  createAnthropicStreamState,
  parseAnthropicModelsResponse,
  parseAnthropicResponse,
  parseAnthropicStreamEvent,
} from '../src/wire.ts'

const context: ChatContext = { model: anthropicModels[0] }

describe('Anthropic wire protocol', () => {
  it('builds a Messages API request', () => {
    const body = buildAnthropicRequestBody(
      {
        model: 'claude-sonnet-4-5',
        messages: [
          { role: 'system', content: '你是助手' },
          { role: 'user', content: '你好' },
        ],
        maxTokens: 256,
      },
      context,
    )
    expect(body.system).toBe('你是助手')
    expect(body.model).toBe('claude-sonnet-4-5-20250929')
    expect(body.max_tokens).toBe(256)
    expect(body.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: '你好' }] }])
  })

  it('maps tool calls and usage', () => {
    const response = parseAnthropicResponse(
      {
        id: 'msg_test',
        model: 'claude-sonnet-4-5',
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'weather', input: { city: '上海' } }],
        stop_reason: 'tool_use',
        usage: { input_tokens: 8, output_tokens: 4 },
      },
      'claude-sonnet-4-5',
    )
    expect(response.choices[0].message.toolCalls?.[0].function.arguments).toBe('{"city":"上海"}')
    expect(response.usage.totalTokens).toBe(12)
    expect(response.choices[0].finishReason).toBe('tool_calls')
  })

  it('parses streaming events', () => {
    const state = createAnthropicStreamState('claude-sonnet-4-5')
    const start = parseAnthropicStreamEvent(
      { type: 'message_start', message: { id: 'msg_stream', model: 'claude-sonnet-4-5', usage: { input_tokens: 3 } } },
      state,
    )
    const text = parseAnthropicStreamEvent(
      { type: 'content_block_delta', delta: { type: 'text_delta', text: '你好' } },
      state,
    )
    const finish = parseAnthropicStreamEvent(
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
      state,
    )
    expect(start[0].id).toBe('msg_stream')
    expect(text[0].delta.content).toBe('你好')
    expect(finish[0].finishReason).toBe('stop')
  })

  it('parses model catalog responses', () => {
    const models = parseAnthropicModelsResponse({
      data: [{ id: 'claude-sonnet-4-5', display_name: 'Claude Sonnet 4.5', created_at: '2025-09-29' }],
    })
    expect(models).toEqual([{
      id: 'claude-sonnet-4-5',
      displayName: 'Claude Sonnet 4.5',
      createdAt: '2025-09-29',
    }])
  })
})
