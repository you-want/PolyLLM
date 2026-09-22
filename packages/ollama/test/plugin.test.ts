import { describe, expect, it, vi } from 'vitest'
import { createLLM } from '@you-want/polyllm-core'
import { ollamaPlugin, parseOllamaTagsResponse } from '../src/index.ts'

describe('parseOllamaTagsResponse', () => {
  it('parses native /api/tags into ProviderModelInfo', () => {
    const models = parseOllamaTagsResponse({
      models: [
        { name: 'llama3.1:8b', size: 4766977432, modified_at: '2024-01-01T00:00:00Z' },
        { model: 'qwen2.5:7b' },
      ],
    })
    expect(models).toEqual([
      { id: 'llama3.1:8b', displayName: 'llama3.1:8b', createdAt: '2024-01-01T00:00:00Z', metadata: { size: 4766977432 } },
      { id: 'qwen2.5:7b', displayName: 'qwen2.5:7b', metadata: {} },
    ])
  })

  it('handles empty or missing models array', () => {
    expect(parseOllamaTagsResponse({})).toEqual([])
    expect(parseOllamaTagsResponse({ models: [] })).toEqual([])
  })
})

describe('ollamaPlugin', () => {
  it('exposes a conservative dynamic model spec', () => {
    expect(ollamaPlugin.createModelSpec?.('llama3.1:8b')).toMatchObject({
      id: 'llama3.1:8b',
      provider: 'ollama',
    })
  })

  it('does not require an API key (local service)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ models: [] }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const models = await ollamaPlugin.listModels?.({})
    expect(models).toEqual([])
    expect(fetchMock.mock.calls[0]?.[0]).toContain('/api/tags')
    vi.unstubAllGlobals()
  })

  it('registers with createLLM without an API key (parity with Python side)', () => {
    const llm = createLLM({
      plugins: [ollamaPlugin],
      providers: { ollama: {} },
    })
    expect(llm.getModelInfo('ollama:llama3.1:8b')?.provider).toBe('ollama')
  })
})
