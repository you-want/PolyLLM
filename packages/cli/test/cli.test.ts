import { describe, expect, it } from 'vitest'
import { doctorConfig, generateProjectFiles, listSelectedModels, parsePolyLLMConfig } from '../src/index.ts'

const config = parsePolyLLMConfig({
  plugins: ['openai', 'deepseek'],
  providers: {
    openai: { apiKeyEnv: 'OPENAI_API_KEY' },
    deepseek: { apiKeyEnv: 'DEEPSEEK_API_KEY' },
  },
  models: {
    openai: ['gpt-4o-mini'],
    deepseek: ['deepseek-chat'],
  },
  defaultModels: {
    openai: 'gpt-4o-mini',
    deepseek: 'deepseek-chat',
  },
  paramPolicy: 'strict',
})

describe('PolyLLM CLI', () => {
  it('validates config files', () => {
    expect(() =>
      parsePolyLLMConfig({
        plugins: ['unknown'],
        providers: { unknown: { apiKeyEnv: 'X' } },
      }),
    ).toThrow()
    expect(config.plugins).toEqual(['openai', 'deepseek'])
  })

  it('generates a runnable TypeScript project', () => {
    const files = generateProjectFiles(config, { projectName: 'my-llm-app' })
    const paths = files.map((file) => file.path)
    expect(paths).toContain('polyllm.config.json')
    expect(paths).toContain('package.json')
    expect(paths).toContain('src/llm.ts')
    const manifest = JSON.parse(files.find((file) => file.path === 'package.json')?.content ?? '{}') as {
      dependencies: Record<string, string>
    }
    expect(manifest.dependencies['@you-want/polyllm-openai']).toBe('^0.2.0')
    expect(files.find((file) => file.path === 'polyllm.config.json')?.content).toContain('models')
    expect(files.find((file) => file.path === 'src/llm.ts')?.content).toContain('export const defaultModel = "openai:gpt-4o-mini"')
    expect(files.find((file) => file.path === 'src/llm.ts')?.content).toContain('allowUnlistedModels: true')
  })

  it('generates a Python project from shared configuration', () => {
    const files = generateProjectFiles(config, {
      projectName: 'my-python-app',
      language: 'python',
      packageManager: 'pip',
    })
    const paths = files.map((file) => file.path)
    expect(paths).toContain('pyproject.toml')
    expect(paths).toContain('src/my_python_app/llm.py')
    expect(files.find((file) => file.path === 'pyproject.toml')?.content).toContain('polyllm-openai>=0.2.0,<0.3.0')
  })

  it('checks environment variables and lists models', () => {
    expect(doctorConfig(config, { OPENAI_API_KEY: 'k', DEEPSEEK_API_KEY: '' }).ok).toBe(false)
    expect(listSelectedModels(config)).toContain('openai:gpt-4o-mini')
    expect(listSelectedModels(config)).toContain('deepseek:deepseek-chat')
  })
})
