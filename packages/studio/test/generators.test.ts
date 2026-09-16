import { describe, expect, it } from 'vitest'
import {
  createDefaultSelection,
  generateConfigJson,
  generateEnvTemplate,
  generateInstallCommand,
  generateLLMModule,
  generateSelectedModels,
} from '../src/index.ts'

describe('PolyLLM Studio generators', () => {
  it('generates a valid explicit plugin configuration', () => {
    const selection = createDefaultSelection()
    selection.providers.openai.models = ['gpt-4o-mini', 'gpt-4o']
    selection.providers.openai.defaultModel = 'gpt-4o-mini'
    const config = JSON.parse(generateConfigJson(selection)) as { plugins: string[] }
    expect(config.plugins).toEqual(['openai'])
    expect(config.models.openai).toEqual(['gpt-4o-mini', 'gpt-4o'])
    expect(config.defaultModels.openai).toBe('gpt-4o-mini')
  })

  it('generates package installation commands', () => {
    const selection = createDefaultSelection()
    selection.providers.deepseek.enabled = true
    expect(generateInstallCommand(selection)).toBe(
      'pnpm add @you-want/polyllm-core @you-want/polyllm-openai @you-want/polyllm-deepseek',
    )
  })

  it('generates environment and source artifacts', () => {
    const selection = createDefaultSelection()
    selection.providers.anthropic.enabled = true
    selection.providers.anthropic.models = ['claude-haiku-4-5']
    selection.providers.anthropic.defaultModel = 'claude-haiku-4-5'
    expect(generateEnvTemplate(selection)).toContain('ANTHROPIC_API_KEY=')
    expect(generateLLMModule(selection)).toContain("import { anthropicPlugin } from '@you-want/polyllm-anthropic'")
    expect(generateLLMModule(selection)).toContain('allowUnlistedModels: true')
    expect(generateLLMModule(selection)).toContain("export const defaultModel = 'anthropic:claude-haiku-4-5'")
    expect(generateSelectedModels(selection)).toContain('anthropic:claude-haiku-4-5')
  })
})
