import { describe, expect, it, vi } from 'vitest'
import type { ChatContext } from '@you-want/polyllm-core'
import { geminiModels } from '../src/models.ts'
import {
  buildGeminiRequestBody,
  createGeminiStreamState,
  normalizeGeminiModelId,
  parseGeminiModelsResponse,
  parseGeminiResponse,
  parseGeminiStreamEvent,
} from '../src/wire.ts'

const context: ChatContext = { model: geminiModels[0] }

describe('Gemini wire protocol', () => {
  it('builds a request with system instruction, tools, and output token cap', () => {
    const body = buildGeminiRequestBody(
      {
        model: 'gemini-2.5-flash',
        messages: [
          { role: 'system', content: '你是助手' },
          { role: 'user', content: '你好' },
        ],
        temperature: 0.5,
        maxTokens: 512,
        tools: [
          {
            type: 'function',
            function: { name: 'get_weather', description: '查天气', parameters: { type: 'object', properties: { city: { type: 'string' } } } },
          },
        ],
      },
      context,
    )
    expect(body.systemInstruction).toEqual({ parts: [{ text: '你是助手' }] })
    expect(body.contents).toEqual([{ role: 'user', parts: [{ text: '你好' }] }])
    expect(body.temperature).toBe(0.5)
    expect(body.maxOutputTokens).toBe(512)
    expect(body.tools?.[0].functionDeclarations?.[0].name).toBe('get_weather')
  })

  it('maps assistant tool calls back to functionCall parts', () => {
    const body = buildGeminiRequestBody(
      {
        model: 'gemini-2.5-flash',
        messages: [
          { role: 'user', content: '北京天气' },
          {
            role: 'assistant',
            content: '',
            toolCalls: [
              { id: 'c1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"北京"}' } },
            ],
          },
          { role: 'tool', toolCallId: 'c1', name: 'get_weather', content: '{"temp":10}' },
        ],
      },
      context,
    )
    expect(body.contents[1].parts).toEqual([
      { functionCall: { name: 'get_weather', args: { city: '北京' } } },
    ])
    expect(body.contents[2].parts).toEqual([
      { functionResponse: { name: 'get_weather', response: { temp: 10 } } },
    ])
  })

  it('parses a response', () => {
    const response = parseGeminiResponse(
      {
        candidates: [
          {
            content: { parts: [{ text: '你好！' }] },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 4, totalTokenCount: 7 },
      },
      'gemini-2.5-flash',
    )
    expect(response.choices[0].message.content).toBe('你好！')
    expect(response.usage.totalTokens).toBe(7)
    expect(response.choices[0].finishReason).toBe('stop')
  })

  it('parses stream chunks', () => {
    const state = createGeminiStreamState()
    const chunks = parseGeminiStreamEvent(
      { candidates: [{ content: { parts: [{ text: '好' }] } }] },
      state,
      'gemini-2.5-flash',
    )
    expect(chunks[0].delta.content).toBe('好')
  })

  it('parses model catalog responses and strips the models/ resource prefix', () => {
    const models = parseGeminiModelsResponse({
      models: [{ name: 'models/gemini-2.5-flash', displayName: 'Gemini 2.5 Flash' }],
    })
    expect(models).toEqual([{ id: 'gemini-2.5-flash', displayName: 'Gemini 2.5 Flash' }])
  })

  it('normalizes model ids', () => {
    expect(normalizeGeminiModelId('models/gemini-2.5-flash')).toBe('gemini-2.5-flash')
    expect(normalizeGeminiModelId('gemini-2.5-flash')).toBe('gemini-2.5-flash')
  })

  it('rejects remote image URLs at the wire boundary', () => {
    expect(() =>
      buildGeminiRequestBody(
        {
          model: 'gemini-2.5-flash',
          messages: [
            {
              role: 'user',
              content: [{ type: 'image_url', imageUrl: { url: 'https://example.com/a.png' } }],
            },
          ],
        },
        context,
      ),
    ).toThrow('暂不支持远程图片 URL')
  })
})
