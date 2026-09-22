export interface NewPluginOptions {
  providerId: string
  providerName: string
  targetDir: string
}

interface GeneratedFile {
  path: string
  content: string
}

function packageName(options: NewPluginOptions): string {
  const normalized = options.providerId.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '')
  return normalized || 'my-provider'
}

export function generateNewPluginFiles(options: NewPluginOptions): GeneratedFile[] {
  const pkg = packageName(options)
  const providerImport = pkg.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase())
  const importNameForProvider = `${providerImport}Plugin`
  const providerId = options.providerId.trim()
  const providerName = options.providerName.trim() || providerId

  const pluginSource = [
    'import {',
    '  PolyLLMError,',
    '  resolveProviderRuntime,',
    '  type ChatContext,',
    '  type JsonRecord,',
    '  type LLMPlugin,',
    '  type ProviderModelInfo,',
    '  type ProviderConfig,',
    '  type ModelSpec,',
    '  type UnifiedRequest,',
    '  type UnifiedResponse,',
    '  type UnifiedStreamChunk,',
    "} from '@you-want/polyllm-core'",
    '',
    `const DEFAULT_BASE_URL = 'https://api.${pkg}.example.com/v1'`,
    '',
    'function endpoint(baseUrl: string, path: string): string {',
    "  return `${baseUrl || DEFAULT_BASE_URL}${path}`",
    '}',
    '',
    'function combineSignals(signal: AbortSignal | undefined, timeoutMs: number | undefined): AbortSignal | undefined {',
    '  if (!timeoutMs) return signal',
    '  const timeout = AbortSignal.timeout(timeoutMs)',
    '  if (!signal) return timeout',
    '  return AbortSignal.any([signal, timeout])',
    '}',
    '',
    'async function readErrorMessage(response: Response): Promise<string> {',
    "  const text = await response.text()",
    '  return text || response.statusText',
    '}',
    '',
    `export const ${importNameForProvider}: LLMPlugin = {`,
    `  provider: '${providerId}',`,
    '  models: [],',
    '  createModelSpec(id: string): ModelSpec {',
    '    return {',
    '      id,',
    `      provider: '${providerId}',`,
    '      capabilities: {',
    '        streaming: true,',
    '        vision: false,',
    '        functionCalling: false,',
    '        jsonMode: false,',
    '        systemPrompt: true,',
    '      },',
    '      params: {',
    '        temperature: { min: 0, max: 2, default: 1 },',
    "        maxTokens: { min: 1, max: 8192, default: 4096, field: 'max_tokens' },",
    '        topP: { min: 0, max: 1, default: 1 },',
    '      },',
    '      contextWindow: 0,',
    '      maxOutput: 4096,',
    '    }',
    '  },',
    '  async listModels(config: ProviderConfig): Promise<ProviderModelInfo[]> {',
    `    const runtime = resolveProviderRuntime('${providerId}', config)`,
    "    const response = await fetch(endpoint(runtime.baseUrl, '/models'), {",
    '      headers: {',
    "        authorization: `Bearer ${runtime.apiKey}`,",
    '        ...runtime.headers,',
    '      },',
    '    })',
    '    if (!response.ok) {',
    "      throw new PolyLLMError('PROVIDER_ERROR',",
    `        \`${providerName} 模型列表获取失败: ${'$'}{response.status} ${'$'}{await readErrorMessage(response)}\`,` ,
    `        { status: response.status, provider: '${providerId}' },` ,
    '      )',
    '    }',
    '    return []',
    '  },',
    '  async chat(',
    '    request: UnifiedRequest,',
    '    config: ProviderConfig,',
    '    context: ChatContext,',
    '  ): Promise<UnifiedResponse> {',
    `    const runtime = resolveProviderRuntime('${providerId}', config)`,
    "    const response = await fetch(endpoint(runtime.baseUrl, '/chat/completions'), {",
    "      method: 'POST',",
    '      headers: {',
    "        'content-type': 'application/json',",
    "        authorization: `Bearer ${runtime.apiKey}`,",
    '        ...runtime.headers,',
    '      },',
    '      body: JSON.stringify({ model: request.model, messages: request.messages }),',
    '      signal: combineSignals(context.signal, context.timeoutMs) ?? null,',
    '    })',
    '    if (!response.ok) {',
    "      throw new PolyLLMError('PROVIDER_ERROR',",
    `        \`${providerName} API 错误: ${'$'}{response.status} ${'$'}{await readErrorMessage(response)}\`, {`,
    '        status: response.status,',
    `        provider: '${providerId}',`,
    '      })',
    '    }',
    '    const data = (await response.json()) as JsonRecord',
    "    const text = (data as { choices?: { message?: { content?: string } }[] }).choices?.[0]?.message?.content ?? ''",
    '    return {',
    "      id: '',",
    '      model: context.model.id,',
    "      choices: [{ index: 0, message: { role: 'assistant', content: text }, finishReason: 'stop' }],",
    '      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },',
    '      providerMetadata: data,',
    '    }',
    '  },',
    '}',
    '',
    'export { PolyLLMError }',
  ].join('\n')

  const testSource = `import { describe, expect, it, vi } from 'vitest'
import { ${importNameForProvider} } from '../src/index.ts'

describe('${importNameForProvider}', () => {
  it('exposes a dynamic model spec', () => {
    expect(${importNameForProvider}.createModelSpec?.('my-model')).toMatchObject({
      id: 'my-model',
      provider: '${providerId}',
    })
  })

  it('requires an API key', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('network'))
    vi.stubGlobal('fetch', fetchMock)
    await expect(${importNameForProvider}.listModels?.({})).rejects.toThrow()
    vi.unstubAllGlobals()
  })
})
`

  const files: GeneratedFile[] = [
    {
      path: 'package.json',
      content: JSON.stringify({
        name: `@you-want/polyllm-${pkg}`,
        version: '0.1.0',
        type: 'module',
        description: `PolyLLM ${options.providerName} provider plugin.`,
        license: 'MIT',
        main: './dist/index.js',
        types: './dist/index.d.ts',
        exports: { '.': { types: './dist/index.d.ts', import: './dist/index.js' } },
        files: ['dist', 'CHANGELOG.md'],
        scripts: { build: 'tsc -p tsconfig.json', test: 'vitest run', typecheck: 'tsc -p tsconfig.json --noEmit' },
        dependencies: { '@you-want/polyllm-core': 'workspace:*' },
        devDependencies: {
          '@types/node': '^22.18.0',
          typescript: '^5.9.3',
          vitest: '^3.2.4',
        },
      }, null, 2),
    },
    {
      path: 'tsconfig.json',
      content: JSON.stringify({
        extends: '../../tsconfig.base.json',
        compilerOptions: { outDir: 'dist', rootDir: 'src', types: ['node'] },
        include: ['src'],
      }, null, 2),
    },
    { path: 'src/index.ts', content: pluginSource },
    { path: 'test/plugin.test.ts', content: testSource },
    {
      path: 'README.md',
      content: `# ${options.providerName} PolyLLM 插件

这是一个由 PolyLLM \`new-plugin\` 脚手架生成的供应商插件模板。

## 发布前检查清单

1. 实现 \`listModels\` / \`chat\` / \`chatStream\` 的供应商 wire 协议。
2. 补充 \`models\` 清单（参考 \`@you-want/polyllm-openai\` 的 \`models.ts\`）。
3. 补充 Mock HTTP 集成测试（参考 \`packages/openai-compatible/test\`）。
4. 运行 \`pnpm --filter @you-want/polyllm-${pkg} build test typecheck\`。
5. 用 \`pnpm changeset\` 新增 changeset，选 patch/minor/major。
6. 运行 \`pnpm verify:release\` 校验元数据与版本冻结。
`,
    },
    { path: 'LICENSE', content: '' },
  ]
  return files
}
