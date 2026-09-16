import { describe, expect, it } from 'vitest'
import { createLLM } from '@you-want/polyllm-core'
import { openAICompatiblePlugin } from '../src/index.js'

describe('openAICompatiblePlugin', () => {
  it('creates a conservative dynamic model spec', () => {
    expect(openAICompatiblePlugin.createModelSpec('qwen-max')).toMatchObject({
      id: 'qwen-max',
      provider: 'openai-compatible',
    })
  })

  it('requires a base URL', async () => {
    await expect(openAICompatiblePlugin.listModels?.({ apiKey: 'test' })).rejects.toThrow()
  })

  it('resolves custom model IDs through the core client', () => {
    const llm = createLLM({
      plugins: [openAICompatiblePlugin],
      providers: {
        'openai-compatible': { apiKeyEnv: 'OPENAI_COMPATIBLE_API_KEY', baseUrl: 'https://api.example.com/v1' },
      },
      allowUnlistedModels: true,
    })
    expect(llm.getModelInfo('openai-compatible:qwen-max')?.provider).toBe('openai-compatible')
  })
})
