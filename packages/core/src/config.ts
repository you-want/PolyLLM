import { PolyLLMError } from './errors.js'
import type { ProviderConfig, ProviderRuntime } from './types.ts'

type Environment = Record<string, string | undefined>

export function resolveProviderRuntime(
  provider: string,
  config: ProviderConfig,
  environment: Environment = process.env,
): ProviderRuntime {
  const apiKey = config.apiKey ?? (config.apiKeyEnv ? environment[config.apiKeyEnv] : undefined)
  if (!apiKey || !apiKey.trim()) {
    const source = config.apiKey ? 'providers[].apiKey' : config.apiKeyEnv ? `环境变量 ${config.apiKeyEnv}` : `${provider} 配置`
    throw new PolyLLMError('MISSING_API_KEY', `PolyLLM 无法解析 ${provider} 的 API key，来源: ${source}`, {
      provider,
      source,
    })
  }

  return {
    apiKey: apiKey.trim(),
    baseUrl: config.baseUrl ?? '',
    headers: { ...(config.headers ?? {}) },
    extra: { ...(config.extra ?? {}) },
  }
}
