import { describe, expect, it } from 'vitest'
import {
  createDefaultSelection,
  createSelectionFromConfig,
  generateConfigJson,
  generateInstallCommand,
  generateLLMModule,
  generateProjectFiles,
} from '../src/index.ts'

describe('PolyLLM Studio generators', () => {
  it('round-trips project metadata and provider configuration', () => {
    const selection = createDefaultSelection()
    selection.projectName = 'my-polyllm-app'
    selection.providers.openai.models = ['gpt-4o-mini', 'gpt-4o']
    selection.providers.openai.defaultModel = 'gpt-4o-mini'
    const restored = createSelectionFromConfig(JSON.parse(generateConfigJson(selection)))
    expect(restored.projectName).toBe('my-polyllm-app')
    expect(restored.providers.openai.models).toEqual(['gpt-4o-mini', 'gpt-4o'])
    expect(restored.providers.openai.defaultModel).toBe('gpt-4o-mini')
  })

  it('generates a runnable TypeScript project', () => {
    const selection = createDefaultSelection()
    selection.packageManager = 'npm'
    selection.providers.openai.models = ['gpt-4o-mini']
    selection.providers.openai.defaultModel = 'gpt-4o-mini'
    expect(generateInstallCommand(selection)).toContain('npm install @you-want/polyllm-core')
    expect(generateLLMModule(selection)).toContain('export const defaultModel = "openai:gpt-4o-mini"')
    const files = generateProjectFiles(selection)
    expect(files.map((file) => file.path)).toEqual(expect.arrayContaining(['package.json', 'src/llm.ts', 'src/main.ts']))
    expect(files.find((file) => file.path === 'package.json')?.content).toContain('^0.2.0')
  })

  it('generates a runnable Python project', () => {
    const selection = createDefaultSelection()
    selection.projectName = 'python-polyllm-app'
    selection.language = 'python'
    selection.packageManager = 'pip'
    selection.providers.openai.enabled = false
    selection.providers.deepseek.enabled = true
    selection.providers.deepseek.models = ['deepseek-chat']
    selection.providers.deepseek.defaultModel = 'deepseek-chat'
    expect(generateInstallCommand(selection)).toContain('python -m pip install polyllm-core polyllm-deepseek')
    expect(generateLLMModule(selection)).toContain('from polyllm_deepseek import DeepSeekPlugin')
    const files = generateProjectFiles(selection)
    expect(files.map((file) => file.path)).toEqual(expect.arrayContaining([
      'pyproject.toml',
      'src/python_polyllm_app/llm.py',
      'src/python_polyllm_app/main.py',
    ]))
    expect(files.find((file) => file.path === 'pyproject.toml')?.content).toContain('polyllm-deepseek>=0.2.0,<0.3.0')
  })

  it('never writes imported API keys into generated files', () => {
    const selection = createSelectionFromConfig({
      plugins: ['openai'],
      providers: { openai: { apiKey: 'secret-value' } },
      models: { openai: ['gpt-4o-mini'] },
      defaultModels: { openai: 'gpt-4o-mini' },
    })
    const generated = generateProjectFiles(selection).map((file) => file.content).join('\n')
    expect(generated).not.toContain('secret-value')
    expect(generated).toContain('OPENAI_API_KEY')
  })
})
