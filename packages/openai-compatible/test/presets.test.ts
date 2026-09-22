import { describe, expect, it } from 'vitest'
import { openaiCompatiblePresets, type OpenAICompatiblePreset } from '../src/presets.ts'

function preset(id: string): OpenAICompatiblePreset {
  const found = openaiCompatiblePresets.find((entry) => entry.id === id)
  if (!found) throw new Error(`未找到预设: ${id}`)
  return found
}

describe('openaiCompatiblePresets', () => {
  it('覆盖规划中的 OpenRouter/Qwen/Moonshot/Groq/vLLM/LiteLLM', () => {
    expect(openaiCompatiblePresets.map((entry) => entry.id)).toEqual(
      expect.arrayContaining(['openrouter', 'qwen', 'moonshot', 'groq', 'vllm', 'litellm']),
    )
  })

  it('每个预设都带 baseUrl 和 apiKeyEnv', () => {
    for (const entry of openaiCompatiblePresets) {
      expect(entry.baseUrl.trim()).not.toBe('')
      expect(entry.apiKeyEnv.trim()).not.toBe('')
    }
  })

  it('vLLM 和 LiteLLM 默认指向本地/自建网关，模型清单留空由用户填写', () => {
    expect(preset('vllm').baseUrl).toContain('127.0.0.1')
    expect(preset('litellm').baseUrl).toContain('127.0.0.1')
    expect(preset('vllm').defaultModels).toEqual([])
    expect(preset('litellm').defaultModels).toEqual([])
  })

  it('云端预设带默认模型，方便 Studio 直接勾选', () => {
    expect(preset('openrouter').defaultModels.length).toBeGreaterThan(0)
    expect(preset('qwen').defaultModels.length).toBeGreaterThan(0)
  })
})
