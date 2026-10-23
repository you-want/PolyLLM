import type { ModelSpec } from '@you-want/polyllm-core'

export const geminiModels: readonly ModelSpec[] = [
  {
    id: 'gemini-2.5-flash',
    aliases: ['gemini-flash', 'flash'],
    provider: 'gemini',
    version: '2.5',
    snapshot: 'gemini-2.5-flash',
    isLatest: true,
    capabilities: {
      streaming: true,
      vision: true,
      functionCalling: true,
      jsonMode: false,
      systemPrompt: true,
    },
    params: {
      temperature: { min: 0, max: 2, default: 1 },
      maxTokens: { min: 1, max: 65536, default: 8192, field: 'maxOutputTokens' },
      topP: { min: 0, max: 1, default: 1 },
    },
    contextWindow: 1048576,
    maxOutput: 65536,
  },
  {
    id: 'gemini-2.5-pro',
    aliases: ['gemini-pro', 'pro'],
    provider: 'gemini',
    version: '2.5',
    snapshot: 'gemini-2.5-pro',
    isLatest: true,
    capabilities: {
      streaming: true,
      vision: true,
      functionCalling: true,
      jsonMode: false,
      systemPrompt: true,
    },
    params: {
      temperature: { min: 0, max: 2, default: 1 },
      maxTokens: { min: 1, max: 65536, default: 8192, field: 'maxOutputTokens' },
      topP: { min: 0, max: 1, default: 1 },
    },
    contextWindow: 1048576,
    maxOutput: 65536,
  },
]
