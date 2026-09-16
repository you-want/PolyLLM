import { ModelRegistry } from './registry.js'
import { validateAndMapParams } from './params.js'
import { PolyLLMError, UnknownModelError } from './errors.js'
import type {
  ChatOptions,
  ClientConfig,
  LLMClient,
  LLMPlugin,
  ModelSpec,
  UnifiedRequest,
  UnifiedResponse,
  UnifiedStreamChunk,
} from './types.ts'

export class PolyLLM implements LLMClient {
  private readonly plugins = new Map<string, LLMPlugin>()
  private readonly registry = new ModelRegistry()
  private readonly config: ClientConfig

  constructor(config: ClientConfig) {
    this.config = config
    for (const plugin of config.plugins) {
      if (this.plugins.has(plugin.provider)) {
        throw new PolyLLMError('DUPLICATE_PROVIDER', `供应商插件重复注册: ${plugin.provider}`, {
          provider: plugin.provider,
        })
      }
      if (!config.providers[plugin.provider]) {
        throw new PolyLLMError('MISSING_PROVIDER_CONFIG', `缺少供应商配置: ${plugin.provider}`, {
          provider: plugin.provider,
        })
      }
      this.plugins.set(plugin.provider, plugin)
      for (const model of plugin.models) this.registry.register(model)
    }
  }

  async chat(
    model: string,
    request: Omit<UnifiedRequest, 'model'>,
    options: ChatOptions = {},
  ): Promise<UnifiedResponse> {
    const { plugin, spec, prepared } = this.prepare(model, request, options)
    return plugin.chat(prepared, this.config.providers[plugin.provider], {
      model: spec,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
    })
  }

  async *chatStream(
    model: string,
    request: Omit<UnifiedRequest, 'model'>,
    options: ChatOptions = {},
  ): AsyncIterable<UnifiedStreamChunk> {
    const { plugin, spec, prepared } = this.prepare(model, { ...request, stream: true }, options)
    if (!plugin.chatStream) {
      throw new PolyLLMError('UNSUPPORTED_PARAMETER', `插件 ${plugin.provider} 不支持流式输出`, {
        provider: plugin.provider,
      })
    }
    yield* plugin.chatStream(prepared, this.config.providers[plugin.provider], {
      model: spec,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
    })
  }

  listModels(): ModelSpec[] {
    return this.registry.list()
  }

  getModelInfo(model: string): ModelSpec | undefined {
    try {
      return this.registry.resolve(model)
    } catch (error) {
      if (!(error instanceof UnknownModelError) || !this.config.allowUnlistedModels) return undefined
      try {
        const separator = model.indexOf(':')
        if (separator <= 0) return undefined
        const provider = model.slice(0, separator)
        const modelId = model.slice(separator + 1)
        const plugin = this.plugins.get(provider)
        return plugin?.createModelSpec?.(modelId)
      } catch {
        return undefined
      }
    }
  }

  private prepare(
    model: string,
    request: Omit<UnifiedRequest, 'model'>,
    options: ChatOptions,
  ): { plugin: LLMPlugin; spec: ModelSpec; prepared: UnifiedRequest } {
    let spec: ModelSpec
    try {
      spec = this.registry.resolve(model)
    } catch (error) {
      if (!(error instanceof UnknownModelError) || !this.config.allowUnlistedModels) throw error
      const separator = model.indexOf(':')
      if (separator <= 0) throw error
      const provider = model.slice(0, separator)
      const dynamicPlugin = this.plugins.get(provider)
      const modelId = model.slice(separator + 1)
      if (!dynamicPlugin?.createModelSpec || !modelId) throw error
      spec = dynamicPlugin.createModelSpec(modelId)
    }
    const plugin = this.plugins.get(spec.provider)
    if (!plugin) {
      throw new PolyLLMError('MISSING_PROVIDER_CONFIG', `模型 ${model} 对应的插件未注册`, { provider: spec.provider })
    }
    const { request: prepared } = validateAndMapParams(
      spec,
      { ...request, model: spec.id },
      this.config.paramPolicy ?? 'strict',
    )
    return { plugin, spec, prepared }
  }
}

export function createLLM(config: ClientConfig): LLMClient {
  return new PolyLLM(config)
}
