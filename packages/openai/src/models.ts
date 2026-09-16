import type { ModelSpec } from '@you-want/polyllm-core'

export const openAIModels: readonly ModelSpec[] = [
  {
    id: 'gpt-4o',
    aliases: ['gpt4o', 'gpt-4o-latest'],
    provider: 'openai',
    version: '2024-11-20',
    snapshot: 'gpt-4o-2024-11-20',
    isLatest: true,
    capabilities: {
      streaming: true,
      vision: true,
      functionCalling: true,
      jsonMode: true,
      systemPrompt: true,
    },
    params: {
      temperature: { min: 0, max: 2, default: 1 },
      maxTokens: { min: 16, max: 16384, default: 4096, field: 'max_completion_tokens' },
      topP: { min: 0, max: 1, default: 1 },
    },
    contextWindow: 128000,
    maxOutput: 16384,
  },
  {
    id: 'gpt-4o-mini',
    aliases: ['gpt4o-mini', 'mini'],
    provider: 'openai',
    version: '2024-07-18',
    snapshot: 'gpt-4o-mini-2024-07-18',
    capabilities: {
      streaming: true,
      vision: true,
      functionCalling: true,
      jsonMode: true,
      systemPrompt: true,
    },
    params: {
      temperature: { min: 0, max: 2, default: 1 },
      maxTokens: { min: 16, max: 16384, default: 4096, field: 'max_completion_tokens' },
      topP: { min: 0, max: 1, default: 1 },
    },
    contextWindow: 128000,
    maxOutput: 16384,
  },
]
