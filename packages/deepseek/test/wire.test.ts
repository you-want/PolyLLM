import { describe, expect, it } from 'vitest'
import type { ChatContext } from '@you-want/polyllm-core'
import { deepSeekModels } from '../src/models.ts'
import {
  buildDeepSeekRequestBody,
  parseDeepSeekModelsResponse,
  parseDeepSeekResponse,
  parseDeepSeekStreamEvent,
} from '../src/wire.ts'

const context: ChatContext = { model: deepSeekModels[0] }

describe('DeepSeek wire protocol', () => {
  it('builds an OpenAI-compatible request', () => {
    const body = buildDeepSeekRequestBody(
      {
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: '你好' }],
        temperature: 0.1,
        maxTokens: 512,
        jsonMode: true,
      },
      context,
    )
    expect(body.model).toBe('deepseek-chat')
    expect(body.max_tokens).toBe(512)
    expect(body.response_format).toEqual({ type: 'json_object' })
  })

  it('parses a response', () => {
    const response = parseDeepSeekResponse(
      {
        id: 'deepseek-test',
        model: 'deepseek-chat',
        choices: [{ message: { role: 'assistant', content: '你好！' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
      },
      'deepseek-chat',
    )
    expect(response.choices[0].message.content).toBe('你好！')
    expect(response.usage.totalTokens).toBe(7)
  })

  it('parses stream chunks', () => {
    const chunk = parseDeepSeekStreamEvent(
      {
        id: 'deepseek-stream',
        choices: [{ delta: { content: '好' }, finish_reason: null }],
      },
      'deepseek-chat',
    )
    expect(chunk.delta.content).toBe('好')
  })

  it('parses model catalog responses', () => {
    const models = parseDeepSeekModelsResponse({
      data: [{ id: 'deepseek-chat', owned_by: 'deepseek', created: 1 }],
    })
    expect(models).toEqual([{ id: 'deepseek-chat', ownedBy: 'deepseek', createdAt: 1 }])
  })
})
