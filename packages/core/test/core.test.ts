import { describe, expect, it } from 'vitest'
import {
  AmbiguousModelError,
  ModelRegistry,
  PolyLLMError,
  UnknownModelError,
  createLLM,
  resolveProviderRuntime,
  validateAndMapParams,
  type LLMPlugin,
  type ModelSpec,
} from '../src/index.ts'

const model: ModelSpec = {
  id: 'test-model',
  aliases: ['test', 'mini'],
  provider: 'test',
  snapshot: 'test-model-v1',
  capabilities: {
    streaming: true,
    vision: false,
    functionCalling: true,
    jsonMode: true,
    systemPrompt: true,
  },
  params: {
    temperature: { min: 0, max: 1, default: 1 },
    maxTokens: { min: 16, max: 128, default: 64, field: 'max_tokens' },
  },
  contextWindow: 4096,
  maxOutput: 128,
}

function createPlugin(provider = 'test', spec = model): LLMPlugin {
  return {
    provider,
    models: [spec],
    createModelSpec(id: string) {
      return { ...model, id, provider }
    },
    chat: async (request) => ({
      id: 'test-response',
      model: request.model,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'ok' },
          finishReason: 'stop',
        },
      ],
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    }),
  }
}

describe('ModelRegistry via client', () => {
  it('resolves canonical ids, aliases, snapshots, and normalized ids', () => {
    const client = createLLM({ plugins: [createPlugin()], providers: { test: { apiKey: 'test-key' } } })
    expect(client.getModelInfo('test:test-model')?.id).toBe('test-model')
    expect(client.getModelInfo('test:test')?.id).toBe('test-model')
    expect(client.getModelInfo('test:test-model-v1')?.id).toBe('test-model')
    expect(client.getModelInfo('test:testmodel')?.id).toBe('test-model')
  })

  it('throws clear unknown and ambiguous model errors', () => {
    const registry = new ModelRegistry()
    registry.register(model)
    expect(() => registry.resolve('test:missing')).toThrow(UnknownModelError)

    registry.register({ ...model, id: 'test-model', provider: 'other' })
    expect(() => registry.resolve('test-model')).toThrow(AmbiguousModelError)
  })

  it('requires provider config and rejects duplicate providers', () => {
    expect(() => createLLM({ plugins: [createPlugin()], providers: {} })).toThrow(PolyLLMError)
    expect(() =>
      createLLM({
        plugins: [createPlugin(), createPlugin()],
        providers: { test: { apiKey: 'k' } },
      }),
    ).toThrow(PolyLLMError)
  })
})

describe('provider configuration', () => {
  it('resolves API keys from direct values and environment references', () => {
    expect(resolveProviderRuntime('test', { apiKey: ' direct ' }, {}).apiKey).toBe('direct')
    expect(resolveProviderRuntime('test', { apiKeyEnv: 'TEST_KEY' }, { TEST_KEY: 'env-key' }).apiKey).toBe('env-key')
    expect(() => resolveProviderRuntime('test', {}, {})).toThrow(PolyLLMError)
  })
})

describe('parameter validation', () => {
  it('strictly rejects unsupported vision requests', () => {
    expect(() =>
      validateAndMapParams(
        model,
        {
          model: 'test-model',
          messages: [{ role: 'user', content: [{ type: 'image_url', imageUrl: { url: 'https://example.com/a.png' } }] }],
        },
        'strict',
      ),
    ).toThrow(PolyLLMError)
  })

  it('automatically clamps out-of-range parameters', () => {
    const result = validateAndMapParams(
      model,
      { model: 'test-model', messages: [{ role: 'user', content: 'hi' }], temperature: 2, maxTokens: 999 },
      'auto',
    )
    expect(result.request.temperature).toBe(1)
    expect(result.request.maxTokens).toBe(128)
    expect(result.warnings).toHaveLength(2)
  })

  it('routes chats through the selected plugin', async () => {
    const client = createLLM({ plugins: [createPlugin()], providers: { test: { apiKey: 'k' } } })
    const response = await client.chat('test:mini', { messages: [{ role: 'user', content: 'hi' }] })
    expect(response.model).toBe('test-model')
  })

  it('resolves explicit unlisted models when allowed', async () => {
    const client = createLLM({
      plugins: [createPlugin()],
      providers: { test: { apiKey: 'k' } },
      allowUnlistedModels: true,
    })
    const response = await client.chat('test:remote-only-model', {
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect(response.model).toBe('remote-only-model')
  })
})
