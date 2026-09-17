import type { ProviderConfig } from '@you-want/polyllm-core'
import { getProviderCatalog, providerCatalog } from './catalog.js'
import type {
  GeneratedProjectFile,
  PackageManager,
  StudioConfig,
  StudioLanguage,
  StudioSelection,
} from './types.js'

const generatedVersion = '^0.2.0'

export function packageManagers(language: StudioLanguage): readonly PackageManager[] {
  return language === 'python' ? ['pip'] : ['pnpm', 'npm', 'yarn']
}

function normalizePackageManager(language: StudioLanguage, value: unknown): PackageManager {
  const managers = packageManagers(language)
  return typeof value === 'string' && managers.includes(value as PackageManager)
    ? value as PackageManager
    : language === 'python' ? 'pip' : 'pnpm'
}

function safeProjectName(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value.trim() : 'polyllm-app'
}

function pythonDistributionName(projectName: string): string {
  return projectName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'polyllm-app'
}

function pythonModuleName(projectName: string): string {
  const normalized = projectName.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'polyllm_app'
  return /^[a-z_]/.test(normalized) ? normalized : `app_${normalized}`
}

function quote(value: string): string {
  return JSON.stringify(value)
}

function enabledProviders(selection: StudioSelection) {
  return providerCatalog.filter((provider) => selection.providers[provider.id].enabled)
}

export function createDefaultSelection(): StudioSelection {
  return {
    projectName: 'polyllm-app',
    language: 'typescript',
    packageManager: 'pnpm',
    paramPolicy: 'strict',
    providers: {
      openai: { enabled: true, apiKeyEnv: 'OPENAI_API_KEY', models: [] },
      deepseek: { enabled: false, apiKeyEnv: 'DEEPSEEK_API_KEY', models: [] },
      anthropic: { enabled: false, apiKeyEnv: 'ANTHROPIC_API_KEY', models: [] },
      'openai-compatible': { enabled: false, apiKeyEnv: 'OPENAI_COMPATIBLE_API_KEY', models: [] },
    },
  }
}

export function generateConfig(selection: StudioSelection): StudioConfig {
  const enabled = enabledProviders(selection)
  if (!enabled.length) throw new Error('请至少选择一个模型供应商')
  const providers: StudioConfig['providers'] = {}
  for (const catalog of enabled) {
    const provider = selection.providers[catalog.id]
    providers[catalog.pluginName] = {
      apiKeyEnv: provider.apiKeyEnv || catalog.apiKeyEnv,
      ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
    }
  }
  const models = Object.fromEntries(enabled.map((provider) => [
    provider.pluginName,
    selection.providers[provider.id].models,
  ]))
  const defaultModels = Object.fromEntries(enabled.flatMap((provider) => {
    const model = selection.providers[provider.id].defaultModel
    return model ? [[provider.pluginName, model]] : []
  }))
  return {
    schemaVersion: 1,
    project: {
      name: safeProjectName(selection.projectName),
      language: selection.language,
      packageManager: normalizePackageManager(selection.language, selection.packageManager),
    },
    plugins: enabled.map((provider) => provider.pluginName),
    providers,
    models,
    ...(Object.keys(defaultModels).length ? { defaultModels } : {}),
    paramPolicy: selection.paramPolicy,
  }
}

export function parseStudioConfig(value: unknown): StudioConfig {
  if (typeof value !== 'object' || value === null) throw new Error('polyllm.config.json 必须是 JSON 对象')
  const input = value as Partial<StudioConfig> & { project?: Partial<StudioConfig['project']> }
  if (!Array.isArray(input.plugins) || input.plugins.length === 0) throw new Error('plugins 必须是非空数组')
  const plugins = input.plugins.map(String)
  for (const plugin of plugins) getProviderCatalog(plugin)
  if (typeof input.providers !== 'object' || input.providers === null) throw new Error('providers 必须是对象')
  const providers = input.providers as Record<string, ProviderConfig>
  for (const plugin of plugins) {
    const provider = providers[plugin]
    if (!provider) throw new Error(`插件 ${plugin} 缺少 providers.${plugin} 配置`)
    if (!provider.apiKey && !provider.apiKeyEnv) throw new Error(`providers.${plugin} 必须配置 apiKeyEnv 或 apiKey`)
  }
  const models = input.models && typeof input.models === 'object' ? input.models : {}
  for (const [provider, entries] of Object.entries(models)) {
    getProviderCatalog(provider)
    if (!Array.isArray(entries) || entries.some((model) => typeof model !== 'string')) {
      throw new Error(`models.${provider} 必须是字符串数组`)
    }
  }
  const defaultModels = input.defaultModels && typeof input.defaultModels === 'object' ? input.defaultModels : {}
  for (const [provider, model] of Object.entries(defaultModels)) {
    getProviderCatalog(provider)
    if (typeof model !== 'string' || !model.trim()) throw new Error(`defaultModels.${provider} 必须是非空字符串`)
    if (!models[provider]?.includes(model)) throw new Error(`defaultModels.${provider} 必须出现在 models.${provider}`)
  }
  const paramPolicy = input.paramPolicy ?? 'strict'
  if (!['strict', 'lenient', 'auto'].includes(paramPolicy)) throw new Error(`未知参数策略: ${paramPolicy}`)
  const language: StudioLanguage = input.project?.language === 'python' ? 'python' : 'typescript'
  return {
    schemaVersion: 1,
    project: {
      name: safeProjectName(input.project?.name),
      language,
      packageManager: normalizePackageManager(language, input.project?.packageManager),
    },
    plugins,
    providers,
    models,
    ...(Object.keys(defaultModels).length ? { defaultModels } : {}),
    paramPolicy,
  }
}

export function createSelectionFromConfig(value: unknown): StudioSelection {
  const config = parseStudioConfig(value)
  const defaults = createDefaultSelection()
  return {
    projectName: config.project.name,
    language: config.project.language,
    packageManager: config.project.packageManager,
    paramPolicy: config.paramPolicy,
    providers: Object.fromEntries(providerCatalog.map((catalog) => {
      const provider = config.providers[catalog.id]
      return [catalog.id, {
        ...defaults.providers[catalog.id],
        enabled: config.plugins.includes(catalog.id),
        apiKeyEnv: provider?.apiKeyEnv ?? catalog.apiKeyEnv,
        baseUrl: provider?.baseUrl,
        models: config.models[catalog.id] ?? [],
        defaultModel: config.defaultModels?.[catalog.id],
      }]
    })) as StudioSelection['providers'],
  }
}

export function generateConfigJson(selection: StudioSelection): string {
  return `${JSON.stringify(generateConfig(selection), null, 2)}\n`
}

export function generateInstallCommand(selection: StudioSelection): string {
  const selected = enabledProviders(selection)
  if (selection.language === 'python') {
    return `python -m pip install ${['polyllm-core', ...selected.map((provider) => provider.pythonPackageName)].join(' ')}`
  }
  const packages = ['@you-want/polyllm-core', ...selected.map((provider) => provider.packageName)]
  if (selection.packageManager === 'npm') return `npm install ${packages.join(' ')}`
  if (selection.packageManager === 'yarn') return `yarn add ${packages.join(' ')}`
  return `pnpm add ${packages.join(' ')}`
}

export function generateEnvTemplate(selection: StudioSelection): string {
  return `${enabledProviders(selection)
    .map((provider) => `${selection.providers[provider.id].apiKeyEnv || provider.apiKeyEnv}=`)
    .join('\n')}\n`
}

function defaultModel(selection: StudioSelection): string {
  for (const provider of enabledProviders(selection)) {
    const selected = selection.providers[provider.id]
    const model = selected.defaultModel ?? selected.models[0]
    if (model) return `${provider.pluginName}:${model}`
  }
  return ''
}

function typescriptLLMModule(selection: StudioSelection): string {
  const enabled = enabledProviders(selection)
  const providers = enabled.map((provider) => {
    const config = selection.providers[provider.id]
    const fields = [`apiKeyEnv: ${quote(config.apiKeyEnv || provider.apiKeyEnv)}`]
    if (config.baseUrl) fields.push(`baseUrl: ${quote(config.baseUrl)}`)
    return `    ${quote(provider.pluginName)}: { ${fields.join(', ')} },`
  }).join('\n')
  return `import { createLLM } from '@you-want/polyllm-core'\n${enabled
    .map((provider) => `import { ${provider.importName} } from '${provider.packageName}'`)
    .join('\n')}\n\nexport const llm = createLLM({\n  plugins: [\n${enabled
    .map((provider) => `    ${provider.importName},`)
    .join('\n')}\n  ],\n  providers: {\n${providers}\n  },\n  paramPolicy: '${selection.paramPolicy}',\n  allowUnlistedModels: true,\n})\n\nexport const defaultModels = ${JSON.stringify(generateConfig(selection).defaultModels ?? {})} as const\nexport const defaultModel = ${quote(defaultModel(selection))}\n`
}

function pythonLLMModule(selection: StudioSelection): string {
  const enabled = enabledProviders(selection)
  const providers = enabled.map((provider) => {
    const config = selection.providers[provider.id]
    const fields = [`api_key_env=${quote(config.apiKeyEnv || provider.apiKeyEnv)}`]
    if (config.baseUrl) fields.push(`base_url=${quote(config.baseUrl)}`)
    return `        ${quote(provider.pluginName)}: ProviderConfig(${fields.join(', ')}),`
  }).join('\n')
  return `from dotenv import load_dotenv\nfrom polyllm_core import ClientConfig, ProviderConfig, create_llm\n${enabled
    .map((provider) => `from ${provider.pythonModuleName} import ${provider.pythonImportName}`)
    .join('\n')}\n\nload_dotenv()\n\nllm = create_llm(\n    ClientConfig(\n        plugins=[${enabled.map((provider) => `${provider.pythonImportName}()`).join(', ')}],\n        providers={\n${providers}\n        },\n        param_policy=${quote(selection.paramPolicy)},\n        allow_unlisted_models=True,\n    )\n)\n\ndefault_models = ${JSON.stringify(generateConfig(selection).defaultModels ?? {})}\ndefault_model = ${quote(defaultModel(selection))}\n`
}

export function generateLLMModule(selection: StudioSelection): string {
  return selection.language === 'python' ? pythonLLMModule(selection) : typescriptLLMModule(selection)
}

function typescriptProjectFiles(selection: StudioSelection): GeneratedProjectFile[] {
  const dependencies = Object.fromEntries([
    ['@you-want/polyllm-core', generatedVersion],
    ...enabledProviders(selection).map((provider) => [provider.packageName, generatedVersion]),
  ])
  const manager = selection.packageManager === 'npm' || selection.packageManager === 'yarn' ? selection.packageManager : 'pnpm'
  const run = manager === 'npm' ? 'npm run' : manager
  return [
    {
      path: 'package.json',
      content: `${JSON.stringify({
        name: safeProjectName(selection.projectName), version: '0.1.0', private: true, type: 'module',
        engines: { node: '>=20' },
        scripts: { build: 'tsc -p tsconfig.json', start: 'node --env-file=.env dist/main.js', typecheck: 'tsc -p tsconfig.json --noEmit' },
        dependencies,
        devDependencies: { '@types/node': '^22.0.0', typescript: '^5.9.0' },
      }, null, 2)}\n`,
    },
    {
      path: 'tsconfig.json',
      content: `${JSON.stringify({
        compilerOptions: {
          target: 'ES2022', lib: ['ES2022', 'DOM'], module: 'NodeNext', moduleResolution: 'NodeNext',
          strict: true, exactOptionalPropertyTypes: true, outDir: 'dist', rootDir: 'src', sourceMap: true,
        },
        include: ['src'],
      }, null, 2)}\n`,
    },
    { path: 'src/llm.ts', content: typescriptLLMModule(selection) },
    {
      path: 'src/main.ts',
      content: `import { defaultModel, llm } from './llm.js'\n\nconst model = process.argv[2] ?? defaultModel\nconst prompt = process.argv[3] ?? '你好，PolyLLM'\nif (!model) throw new Error('请在 Studio 中选择默认模型，或通过命令行传入模型 ID')\n\nconst response = await llm.chat(model, { messages: [{ role: 'user', content: prompt }] })\nconsole.log(response.choices[0]?.message.content ?? '')\n`,
    },
    { path: '.gitignore', content: 'node_modules/\ndist/\n.env\n' },
    {
      path: 'README.md',
      content: `# ${safeProjectName(selection.projectName)}\n\n由 PolyLLM Studio 生成的 TypeScript 项目。\n\n## 使用\n\n\`\`\`bash\n${manager} install\ncp .env.example .env\n${run} build\n${run} start -- ${defaultModel(selection)} '你好，PolyLLM'\n\`\`\`\n`,
    },
  ]
}

function pythonProjectFiles(selection: StudioSelection): GeneratedProjectFile[] {
  const distribution = pythonDistributionName(selection.projectName)
  const module = pythonModuleName(selection.projectName)
  const dependencies = ['polyllm-core>=0.2.0,<0.3.0', 'python-dotenv>=1.0,<2', ...enabledProviders(selection)
    .map((provider) => `${provider.pythonPackageName}>=0.2.0,<0.3.0`)]
  return [
    {
      path: 'pyproject.toml',
      content: `[build-system]\nrequires = ["setuptools>=68"]\nbuild-backend = "setuptools.build_meta"\n\n[project]\nname = ${quote(distribution)}\nversion = "0.1.0"\ndescription = "PolyLLM generated application"\nrequires-python = ">=3.10"\ndependencies = ${JSON.stringify(dependencies)}\n\n[tool.setuptools.packages.find]\nwhere = ["src"]\n`,
    },
    { path: `src/${module}/__init__.py`, content: '' },
    { path: `src/${module}/llm.py`, content: pythonLLMModule(selection) },
    {
      path: `src/${module}/main.py`,
      content: `import asyncio\nimport sys\n\nfrom .llm import default_model, llm\n\n\nasync def main() -> None:\n    model = sys.argv[1] if len(sys.argv) > 1 else default_model\n    prompt = sys.argv[2] if len(sys.argv) > 2 else "你好，PolyLLM"\n    if not model:\n        raise RuntimeError("请在 Studio 中选择默认模型，或通过命令行传入模型 ID")\n    response = await llm.chat(model, messages=[{"role": "user", "content": prompt}])\n    print(response.choices[0].message.content)\n\n\nif __name__ == "__main__":\n    asyncio.run(main())\n`,
    },
    { path: '.gitignore', content: '.venv/\n__pycache__/\n*.py[cod]\n.env\n' },
    {
      path: 'README.md',
      content: `# ${safeProjectName(selection.projectName)}\n\n由 PolyLLM Studio 生成的 Python 项目。\n\n## 使用\n\n\`\`\`bash\npython3 -m venv .venv\n. .venv/bin/activate\npython -m pip install -e .\ncp .env.example .env\npython -m ${module}.main ${defaultModel(selection)} '你好，PolyLLM'\n\`\`\`\n`,
    },
  ]
}

export function generateProjectFiles(selection: StudioSelection): GeneratedProjectFile[] {
  return [
    { path: 'polyllm.config.json', content: generateConfigJson(selection) },
    { path: '.env.example', content: generateEnvTemplate(selection) },
    ...(selection.language === 'python' ? pythonProjectFiles(selection) : typescriptProjectFiles(selection)),
  ]
}

export function generateSelectedModels(selection: StudioSelection): string[] {
  return enabledProviders(selection).flatMap((provider) => selection.providers[provider.id].models
    .map((model) => `${provider.pluginName}:${model}`))
}

export { getProviderCatalog }
