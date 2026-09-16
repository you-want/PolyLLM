import type { StudioConfig, StudioSelection } from './types.js'
import { getProviderCatalog, providerCatalog } from './catalog.js'

export function createDefaultSelection(): StudioSelection {
  return {
    language: 'typescript',
    packageManager: 'pnpm',
    paramPolicy: 'strict',
    providers: {
      openai: {
        enabled: true,
        apiKeyEnv: 'OPENAI_API_KEY',
        models: [],
      },
      deepseek: {
        enabled: false,
        apiKeyEnv: 'DEEPSEEK_API_KEY',
        models: [],
      },
      anthropic: {
        enabled: false,
        apiKeyEnv: 'ANTHROPIC_API_KEY',
        models: [],
      },
      'openai-compatible': {
        enabled: false,
        apiKeyEnv: 'OPENAI_COMPATIBLE_API_KEY',
        models: [],
      },
    },
  }
}

export function generateConfig(selection: StudioSelection): StudioConfig {
  const plugins: string[] = []
  const providers: StudioConfig['providers'] = {}
  for (const catalog of providerCatalog) {
    const provider = selection.providers[catalog.id]
    if (!provider.enabled) continue
    plugins.push(catalog.pluginName)
    providers[catalog.pluginName] = {
      apiKeyEnv: provider.apiKeyEnv,
      ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
    }
  }
  if (!plugins.length) throw new Error('请至少选择一个模型供应商')
  const models = Object.fromEntries(
    providerCatalog
      .filter((provider) => selection.providers[provider.id].enabled)
      .map((provider) => [provider.pluginName, selection.providers[provider.id].models]),
  )
  const defaultModels = Object.fromEntries(
    providerCatalog
      .filter((provider) => {
        const selected = selection.providers[provider.id]
        return selected.enabled && selected.defaultModel
      })
      .map((provider) => [provider.pluginName, selection.providers[provider.id].defaultModel as string]),
  )
  return {
    plugins,
    providers,
    models,
    ...(Object.keys(defaultModels).length ? { defaultModels } : {}),
    paramPolicy: selection.paramPolicy,
  }
}

export function generateConfigJson(selection: StudioSelection): string {
  return `${JSON.stringify(generateConfig(selection), null, 2)}\n`
}

export function generateInstallCommand(selection: StudioSelection): string {
  const selected = providerCatalog.filter((provider) => selection.providers[provider.id].enabled)
  const packages = ['@you-want/polyllm-core', ...selected.map((provider) => provider.packageName)]
  if (selection.packageManager === 'npm') return `npm install ${packages.join(' ')}`
  if (selection.packageManager === 'yarn') return `yarn add ${packages.join(' ')}`
  return `pnpm add ${packages.join(' ')}`
}

export function generateEnvTemplate(selection: StudioSelection): string {
  const lines = providerCatalog
    .filter((provider) => selection.providers[provider.id].enabled)
    .map((provider) => `${selection.providers[provider.id].apiKeyEnv}=`)
  return `${lines.join('\n')}\n`
}

export function generateLLMModule(selection: StudioSelection): string {
  const enabled = providerCatalog.filter((provider) => selection.providers[provider.id].enabled)
  const imports = [
    `import { createLLM } from '@you-want/polyllm-core'`,
    ...enabled.map((provider) => `import { ${provider.importName} } from '${provider.packageName}'`),
  ]
  const config = generateConfig(selection)
  const pluginImports = providerCatalog.filter((provider) => config.plugins.includes(provider.id))
  const providers = Object.entries(config.providers)
    .map(([name, value]) => `    ${name}: { apiKeyEnv: '${value.apiKeyEnv}'${value.baseUrl ? `, baseUrl: '${value.baseUrl}'` : ''} },`)
    .join('\n')
  const defaultModels = config.defaultModels ?? {}
  const firstDefault = Object.entries(defaultModels)[0]
  return `${imports.join('\n')}

export const llm = createLLM({
  plugins: [
${pluginImports.map((provider) => `    ${provider.importName},`).join('\n')}
  ],
  providers: {
${providers}
  },
  paramPolicy: '${selection.paramPolicy}',
  allowUnlistedModels: true,
})

export const defaultModels = ${JSON.stringify(defaultModels)} as const
export const defaultModel = '${firstDefault ? `${firstDefault[0]}:${firstDefault[1]}` : ''}'
`
}

export function generateSelectedModels(selection: StudioSelection): string[] {
  return providerCatalog.flatMap((provider) => {
    const selected = selection.providers[provider.id]
    if (!selected.enabled) return []
    return selected.models.map((model) => `${provider.pluginName}:${model}`)
  })
}

export { getProviderCatalog }
