import type { ParsedPolyLLMConfig } from './config.js'
import { providerCatalog } from '@you-want/polyllm-studio'

export interface GeneratedFile {
  path: string
  content: string
}

export interface GenerateProjectOptions {
  projectName: string
}

function envTemplate(config: ParsedPolyLLMConfig): string {
  return `${config.plugins
    .map((providerId) => {
      const provider = config.providers[providerId]
      return `${provider.apiKeyEnv ?? provider.apiKey ?? `${providerId.toUpperCase()}_API_KEY`}=`
    })
    .join('\n')}\n`
}

function llmModule(config: ParsedPolyLLMConfig): string {
  const providers = providerCatalog.filter((provider) => config.plugins.includes(provider.id))
  const imports = [
    `import { createLLM } from '@you-want/polyllm-core'`,
    ...providers.map((provider) => `import { ${provider.importName} } from '${provider.packageName}'`),
  ]
  return `${imports.join('\n')}

export const llm = createLLM({
  plugins: [
${providers.map((provider) => `    ${provider.importName},`).join('\n')}
  ],
  providers: {
${config.plugins
  .map((providerId) => {
    const provider = config.providers[providerId]
    const apiKey = provider.apiKey
      ? `apiKey: '${provider.apiKey}'`
      : `apiKeyEnv: '${provider.apiKeyEnv ?? `${providerId.toUpperCase()}_API_KEY`}'`
    const baseUrl = provider.baseUrl ? `, baseUrl: '${provider.baseUrl}'` : ''
    return `    ${providerId}: { ${apiKey}${baseUrl} },`
  })
  .join('\n')}
  },
  paramPolicy: '${config.paramPolicy}',
  allowUnlistedModels: true,
})

export const defaultModels = ${JSON.stringify(config.defaultModels ?? {})} as const
export const defaultModel = '${defaultModel(config)}'
`
}

export function generateProjectFiles(
  config: ParsedPolyLLMConfig,
  options: GenerateProjectOptions,
): GeneratedFile[] {
  const providers = providerCatalog.filter((provider) => config.plugins.includes(provider.id))
  const dependencies: Record<string, string> = {
    '@you-want/polyllm-core': '^0.1.0',
  }
  for (const provider of providers) dependencies[provider.packageName] = '^0.1.0'

  return [
    {
      path: 'polyllm.config.json',
      content: `${JSON.stringify(
        {
          plugins: config.plugins,
          providers: config.providers,
          models: config.models,
          ...(config.defaultModels ? { defaultModels: config.defaultModels } : {}),
          paramPolicy: config.paramPolicy,
        },
        null,
        2,
      )}\n`,
    },
    {
      path: 'package.json',
      content: `${JSON.stringify(
        {
          name: options.projectName,
          version: '0.1.0',
          private: true,
          type: 'module',
          scripts: {
            build: 'tsc -p tsconfig.json',
            start: 'node dist/main.js',
            typecheck: 'tsc -p tsconfig.json --noEmit',
          },
          dependencies,
        },
        null,
        2,
      )}\n`,
    },
    {
      path: 'tsconfig.json',
      content: `${JSON.stringify(
        {
          compilerOptions: {
            target: 'ES2022',
            lib: ['ES2022', 'DOM'],
            module: 'NodeNext',
            moduleResolution: 'NodeNext',
            strict: true,
            exactOptionalPropertyTypes: true,
            outDir: 'dist',
            rootDir: 'src',
            sourceMap: true,
            declaration: true,
          },
          include: ['src'],
        },
        null,
        2,
      )}\n`,
    },
    { path: '.env.example', content: envTemplate(config) },
    { path: 'src/llm.ts', content: llmModule(config) },
    {
      path: 'src/main.ts',
      content: `import { defaultModel, llm } from './llm.js'\n\nconst model = process.argv[2] ?? defaultModel\nconst prompt = process.argv[3] ?? '你好，PolyLLM'\n\nconst response = await llm.chat(model, {\n  messages: [{ role: 'user', content: prompt }],\n})\n\nconsole.log(response.choices[0]?.message.content ?? '')\n`,
    },
    {
      path: '.gitignore',
      content: 'node_modules/\ndist/\n.env\n',
    },
    {
      path: 'README.md',
      content: `# ${options.projectName}\n\n由 PolyLLM CLI 生成的 TypeScript 接入项目。\n\n## 使用\n\n\`\`\`bash\npnpm install\ncp .env.example .env\npnpm build\npnpm start ${defaultModel(config)} '你好'\n\`\`\`\n`,
    },
  ]
}

function defaultModel(config: ParsedPolyLLMConfig): string {
  const providerId = config.plugins[0]
  if (!providerId) return ''
  const model = config.defaultModels?.[providerId] ?? config.models[providerId]?.[0] ?? ''
  return model ? `${providerId}:${model}` : ''
}
