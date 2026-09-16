import type { ModelSpec } from '@you-want/polyllm-core'

export const anthropicModels: readonly ModelSpec[] = [
  {
    id: 'claude-sonnet-4-5',
    aliases: ['claude-sonnet', 'sonnet'],
    provider: 'anthropic',
    version: '2025-09-29',
    snapshot: 'claude-sonnet-4-5-20250929',
    isLatest: true,
    capabilities: {
      streaming: true,
      vision: true,
      functionCalling: true,
      jsonMode: false,
      systemPrompt: true,
    },
    params: {
      temperature: { min: 0, max: 1, default: 1 },
      maxTokens: { min: 1, max: 64000, default: 8192, field: 'max_tokens' },
      topP: { min: 0, max: 1, default: 1 },
    },
    contextWindow: 200000,
    maxOutput: 64000,
  },
  {
    id: 'claude-haiku-4-5',
    aliases: ['claude-haiku', 'haiku'],
    provider: 'anthropic',
    version: '2025-10-01',
    snapshot: 'claude-haiku-4-5-20251001',
    capabilities: {
      streaming: true,
      vision: true,
      functionCalling: true,
      jsonMode: false,
      systemPrompt: true,
    },
    params: {
      temperature: { min: 0, max: 1, default: 1 },
      maxTokens: { min: 1, max: 32000, default: 4096, field: 'max_tokens' },
      topP: { min: 0, max: 1, default: 1 },
    },
    contextWindow: 200000,
    maxOutput: 32000,
  },
]
