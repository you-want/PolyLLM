import type { ModelSpec } from '@you-want/polyllm-core'

export const ollamaModels: readonly ModelSpec[] = [
  {
    id: 'llama3.1:8b',
    aliases: ['llama3.1', 'llama-3.1'],
    provider: 'ollama',
    version: '8b',
    snapshot: 'llama3.1:8b',
    isLatest: true,
    capabilities: {
      streaming: true,
      vision: false,
      functionCalling: true,
      jsonMode: false,
      systemPrompt: true,
    },
    params: {
      temperature: { min: 0, max: 2, default: 1 },
      maxTokens: { min: 1, max: 4096, default: 4096, field: 'max_tokens' },
      topP: { min: 0, max: 1, default: 1 },
    },
    contextWindow: 131072,
    maxOutput: 4096,
  },
  {
    id: 'qwen2.5:7b',
    aliases: ['qwen2.5'],
    provider: 'ollama',
    version: '7b',
    snapshot: 'qwen2.5:7b',
    capabilities: {
      streaming: true,
      vision: false,
      functionCalling: true,
      jsonMode: false,
      systemPrompt: true,
    },
    params: {
      temperature: { min: 0, max: 2, default: 1 },
      maxTokens: { min: 1, max: 4096, default: 4096, field: 'max_tokens' },
      topP: { min: 0, max: 1, default: 1 },
    },
    contextWindow: 32768,
    maxOutput: 4096,
  },
]
