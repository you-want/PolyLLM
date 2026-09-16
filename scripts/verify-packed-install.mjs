import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url))
const packageDirectories = ['core', 'openai', 'deepseek', 'anthropic', 'openai-compatible', 'studio', 'cli']

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error([
      `${command} ${args.join(' ')} failed in ${cwd}`,
      result.error?.message,
      result.stdout,
      result.stderr,
    ].filter(Boolean).join('\n'))
  }
  return result.stdout
}

const temporaryRoot = await mkdtemp(join(tmpdir(), 'polyllm-packed-install-'))
const tarballDirectory = join(temporaryRoot, 'tarballs')
const consumerDirectory = join(temporaryRoot, 'consumer')

try {
  await mkdir(tarballDirectory, { recursive: true })
  await mkdir(consumerDirectory, { recursive: true })

  const dependencies = {}
  for (const directory of packageDirectories) {
    const packageDirectory = join(repositoryRoot, 'packages', directory)
    const manifest = JSON.parse(await readFile(join(packageDirectory, 'package.json'), 'utf8'))
    const before = new Set(await readdir(tarballDirectory))
    run('pnpm', ['pack', '--pack-destination', tarballDirectory], packageDirectory)
    const tarball = (await readdir(tarballDirectory)).find((file) => !before.has(file) && file.endsWith('.tgz'))
    if (!tarball) throw new Error(`No tarball was produced for ${manifest.name}`)
    dependencies[manifest.name] = `file:${join(tarballDirectory, tarball)}`
  }

  await writeFile(join(consumerDirectory, 'package.json'), `${JSON.stringify({
    name: 'polyllm-packed-consumer',
    private: true,
    type: 'module',
    dependencies,
  }, null, 2)}\n`)

  await writeFile(join(consumerDirectory, 'smoke.mjs'), `
import { createLLM } from '@you-want/polyllm-core'
import { openAIPlugin } from '@you-want/polyllm-openai'
import { deepSeekPlugin } from '@you-want/polyllm-deepseek'
import { anthropicPlugin } from '@you-want/polyllm-anthropic'
import { openAICompatiblePlugin } from '@you-want/polyllm-openai-compatible'
import { createDefaultSelection, generateInstallCommand } from '@you-want/polyllm-studio'
import { generateProjectFiles } from '@you-want/polyllm-cli'

const llm = createLLM({
  plugins: [openAIPlugin, deepSeekPlugin, anthropicPlugin, openAICompatiblePlugin],
  providers: {
    openai: { apiKey: 'test' },
    deepseek: { apiKey: 'test' },
    anthropic: { apiKey: 'test' },
    'openai-compatible': { apiKey: 'test', baseUrl: 'http://127.0.0.1' },
  },
})

if (!llm.getModelInfo('openai:gpt-4o-mini')) throw new Error('Core/plugin exports are not usable')
const selection = createDefaultSelection()
if (!generateInstallCommand(selection).includes('@you-want/polyllm-core')) throw new Error('Studio export is not usable')
if (!generateProjectFiles({
  plugins: ['openai'],
  providers: { openai: { apiKeyEnv: 'OPENAI_API_KEY' } },
  models: { openai: ['gpt-4o-mini'] },
  paramPolicy: 'strict',
}, { projectName: 'smoke' }).length) throw new Error('CLI export is not usable')

console.log('Packed package imports verified.')
`)

  await writeFile(join(consumerDirectory, 'smoke.ts'), `
import { createLLM, type UnifiedRequest } from '@you-want/polyllm-core'
import { openAIPlugin } from '@you-want/polyllm-openai'

const request: Omit<UnifiedRequest, 'model'> = {
  messages: [{ role: 'user', content: 'hello' }],
}
const llm = createLLM({ plugins: [openAIPlugin], providers: { openai: { apiKey: 'test' } } })
void llm.chat('openai:gpt-4o-mini', request)
`)

  await writeFile(join(consumerDirectory, 'tsconfig.json'), `${JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      strict: true,
      noEmit: true,
      skipLibCheck: false,
    },
    include: ['smoke.ts'],
  }, null, 2)}\n`)

  run('npm', ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund'], consumerDirectory)
  run('node', ['smoke.mjs'], consumerDirectory)
  run(join(repositoryRoot, 'packages', 'integration', 'node_modules', '.bin', 'tsc'), ['-p', 'tsconfig.json'], consumerDirectory)
  const cliOutput = run('node', [join(consumerDirectory, 'node_modules', '@you-want', 'polyllm-cli', 'dist', 'main.js'), '--help'], consumerDirectory)
  if (!cliOutput.includes('PolyLLM CLI')) throw new Error('Packed CLI binary did not produce help output')

  console.log(`Verified ${Object.keys(dependencies).length} packed packages in an isolated consumer.`)
} finally {
  await rm(temporaryRoot, { recursive: true, force: true })
}
