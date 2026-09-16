import type { ParsedPolyLLMConfig } from './config.js'

export interface DoctorResult {
  ok: boolean
  checks: {
    name: string
    ok: boolean
    message: string
  }[]
}

export function doctorConfig(
  config: ParsedPolyLLMConfig,
  environment: Record<string, string | undefined> = process.env,
): DoctorResult {
  const checks = config.plugins.map((providerId) => {
    const provider = config.providers[providerId]
    const key = provider.apiKey ?? (provider.apiKeyEnv ? environment[provider.apiKeyEnv] : undefined)
    return {
      name: `${providerId} API key`,
      ok: Boolean(key && key.trim()),
      message: key && key.trim()
        ? `已配置${provider.apiKeyEnv ? ` (${provider.apiKeyEnv})` : ''}`
        : `未配置${provider.apiKeyEnv ? ` (${provider.apiKeyEnv})` : ''}`,
    }
  })
  for (const providerId of config.plugins) {
    if (providerId === 'openai-compatible') {
      checks.push({
        name: `${providerId} Base URL`,
        ok: Boolean(config.providers[providerId]?.baseUrl?.trim()),
        message: config.providers[providerId]?.baseUrl?.trim() ? '已配置' : '未配置',
      })
    }
  }
  return { ok: checks.every((check) => check.ok), checks }
}

export function listSelectedModels(config: ParsedPolyLLMConfig): string[] {
  return config.plugins.flatMap((providerId) =>
    (config.models[providerId] ?? []).map((model) => `${providerId}:${model}`),
  )
}
