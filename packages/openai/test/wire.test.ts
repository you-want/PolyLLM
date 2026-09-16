import { describe, expect, it } from 'vitest'
import type { ChatContext } from '@you-want/polyllm-core'
import { openAIModels } from '../src/models.ts'
import {
  buildOpenAIRequestBody,
  parseOpenAIModelsResponse,
  parseOpenAIResponse,
  parseOpenAIStreamEvent,
} from '../src/wire.ts'

const context: ChatContext = { model: openAIModels[0] }

describe('OpenAI wire protocol', () => {
  it('builds a Chat Completions request', () => {
    const body = buildOpenAIRequestBody(
      {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: '你好' }],
        temperature: 0.2,
        maxTokens: 128,
        topP: 0.9,
        jsonMode: true,
      },
      context,
    )
    expect(body.model).toBe('gpt-4o-2024-11-20')
    expect(body.messages[0]).toEqual({ role: 'user', content: '你好' })
    expect(body.max_completion_tokens).toBe(128)
    expect(body.response_format).toEqual({ type: 'json_object' })
  })

  it('parses text and tool-call responses', () => {
    const response = parseOpenAIResponse(
      {
        id: 'chatcmpl-test',
        model: 'gpt-4o-2024-11-20',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [
                { id: 'call_1', type: 'function', function: { name: 'weather', arguments: '{"city":"上海"}' } },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
      'gpt-4o',
    )
    expect(response.choices[0].message.toolCalls?.[0].function.arguments).toBe('{"city":"上海"}')
    expect(response.choices[0].finishReason).toBe('tool_calls')
  })

  it('parses stream chunks', () => {
    const chunk = parseOpenAIStreamEvent(
      {
        id: 'chatcmpl-stream',
        model: 'gpt-4o',
        choices: [{ delta: { content: '你好' }, finish_reason: null }],
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      },
      'gpt-4o',
    )
    expect(chunk.delta.content).toBe('你好')
    expect(chunk.usage?.totalTokens).toBe(3)
  })

  it('parses model catalog responses', () => {
    const models = parseOpenAIModelsResponse({
      data: [
        { id: 'gpt-4o', owned_by: 'openai', created: 1715367049 },
        { id: '', owned_by: 'openai' },
      ],
    })
    expect(models).toEqual([{ id: 'gpt-4o', ownedBy: 'openai', createdAt: 1715367049 }])
  })
})
