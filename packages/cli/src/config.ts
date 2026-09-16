import { readFile } from 'node:fs/promises'
import { PolyLLMError, type ParamPolicy, type ProviderConfig } from '@you-want/polyllm-core'
import { providerCatalog } from '@you-want/polyllm-studio'

export interface PolyLLMFileConfig {
  plugins: readonly string[]
  providers: Record<string, ProviderConfig>
  models?: Record<string, readonly string[]>
  defaultModels?: Record<string, string>
  paramPolicy?: ParamPolicy
}

export interface ParsedPolyLLMConfig {
  plugins: readonly string[]
  providers: Record<string, ProviderConfig>
  models: Record<string, readonly string[]>
  defaultModels?: Record<string, string>
  paramPolicy: ParamPolicy
}

const knownProviderIds: ReadonlySet<string> = new Set(
  providerCatalog.map((provider) => provider.id),
)

function invalid(message: string, details?: Record<string, unknown>): PolyLLMError {
  return new PolyLLMError('INVALID_CONFIG', message, details)
}

export function parsePolyLLMConfig(value: unknown): ParsedPolyLLMConfig {
  if (typeof value !== 'object' || value === null) {
    throw new PolyLLMError('INVALID_CONFIG', 'polyllm.config.json 必须是 JSON 对象')
  }

  const config = value as Partial<PolyLLMFileConfig>
  if (!Array.isArray(config.plugins) || config.plugins.length === 0) {
    throw new PolyLLMError('INVALID_CONFIG', 'plugins 必须是非空数组')
  }
  if (typeof config.providers !== 'object' || config.providers === null) {
    throw new PolyLLMError('INVALID_CONFIG', 'providers 必须是对象')
  }

  const plugins = config.plugins.map(String)
  for (const plugin of plugins) {
    if (!knownProviderIds.has(plugin)) {
      throw new PolyLLMError(
        'INVALID_CONFIG',
        `未知插件: ${plugin}。可用插件: ${[...knownProviderIds].join(', ')}`,
      )
    }
  }

  for (const plugin of plugins) {
    if (!config.providers[plugin]) {
      throw new PolyLLMError('INVALID_CONFIG', `插件 ${plugin} 缺少 providers.${plugin} 配置`)
    }
  }

  const providerEntries = Object.entries(config.providers)
  for (const [provider, providerConfig] of providerEntries) {
    if (!knownProviderIds.has(provider)) {
      throw new PolyLLMError('INVALID_CONFIG', `未知供应商配置: ${provider}`)
    }
    if (!plugins.includes(provider)) {
      throw new PolyLLMError('INVALID_CONFIG', `供应商 ${provider} 已配置但未加入 plugins`)
    }
    if (!providerConfig.apiKey && !providerConfig.apiKeyEnv) {
      throw new PolyLLMError('INVALID_CONFIG', `providers.${provider} 必须配置 apiKeyEnv 或 apiKey`)
    }
  }

  const paramPolicy = config.paramPolicy ?? 'strict'
  if (!['strict', 'lenient', 'auto'].includes(paramPolicy)) {
    throw new PolyLLMError('INVALID_CONFIG', `未知参数策略: ${paramPolicy}`)
  }

  const models = config.models ?? {}
  for (const [provider, providerModels] of Object.entries(models)) {
    if (!knownProviderIds.has(provider)) throw invalid(`未知模型供应商: ${provider}`)
    if (!Array.isArray(providerModels)) throw invalid(`models.${provider} 必须是数组`)
  }

  const defaultModels = config.defaultModels ?? {}
  for (const [provider, model] of Object.entries(defaultModels)) {
    if (!knownProviderIds.has(provider)) throw invalid(`未知默认模型供应商: ${provider}`)
    if (typeof model !== 'string' || !model.trim()) throw invalid(`defaultModels.${provider} 必须是非空字符串`)
    if (!models[provider]?.includes(model)) throw invalid(`defaultModels.${provider} 必须出现在 models.${provider}`)
  }

  return {
    plugins,
    providers: config.providers,
    models,
    ...(Object.keys(defaultModels).length ? { defaultModels } : {}),
    paramPolicy,
  }
}

export async function readPolyLLMConfig(path: string): Promise<ParsedPolyLLMConfig> {
  try {
    const content = await readFile(path, 'utf8')
    return parsePolyLLMConfig(JSON.parse(content))
  } catch (error) {
    if (error instanceof PolyLLMError) throw error
    throw new PolyLLMError('INVALID_CONFIG', `无法读取或解析配置文件: ${path}`, {
      cause: error instanceof Error ? error.message : String(error),
    })
  }
}
