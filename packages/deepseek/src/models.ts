import type { ModelSpec } from '@you-want/polyllm-core'

export const deepSeekModels: readonly ModelSpec[] = [
  {
    id: 'deepseek-chat',
    aliases: ['deepseek-v3', 'chat'],
    provider: 'deepseek',
    isLatest: true,
    capabilities: {
      streaming: true,
      vision: false,
      functionCalling: true,
      jsonMode: true,
      systemPrompt: true,
    },
    params: {
      temperature: { min: 0, max: 2, default: 1 },
      maxTokens: { min: 1, max: 8192, default: 4096, field: 'max_tokens' },
      topP: { min: 0, max: 1, default: 1 },
    },
    contextWindow: 65536,
    maxOutput: 8192,
  },
  {
    id: 'deepseek-reasoner',
    aliases: ['deepseek-r1', 'reasoner'],
    provider: 'deepseek',
    capabilities: {
      streaming: true,
      vision: false,
      functionCalling: true,
      jsonMode: false,
      systemPrompt: true,
    },
    params: {
      temperature: { min: 0, max: 2, default: 1 },
      maxTokens: { min: 1, max: 65536, default: 4096, field: 'max_tokens' },
      topP: { min: 0, max: 1, default: 1 },
    },
    contextWindow: 131072,
    maxOutput: 65536,
  },
]
