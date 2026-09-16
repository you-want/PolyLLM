import { readFile, access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join } from 'node:path'

const publishablePackages = [
  '@you-want/polyllm-core',
  '@you-want/polyllm-openai',
  '@you-want/polyllm-deepseek',
  '@you-want/polyllm-anthropic',
  '@you-want/polyllm-openai-compatible',
  '@you-want/polyllm-studio',
  '@you-want/polyllm-cli',
]

const privateWorkspacePackages = new Set([
  '@you-want/polyllm-studio-app',
  '@you-want/polyllm-example-typescript',
])

const packageRoot = new URL('../packages/', import.meta.url)
const repositoryUrl = 'https://github.com/you-want/PolyLLM'
const homepageUrl = 'https://polly.raingpt.top'
const bugsUrl = 'https://github.com/you-want/PolyLLM/issues'
const errors = []

async function exists(path) {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

async function readPackage(directory) {
  return JSON.parse(await readFile(join(packageRoot.pathname, directory, 'package.json'), 'utf8'))
}

function assert(condition, message) {
  if (!condition) errors.push(message)
}

for (const directory of ['core', 'openai', 'deepseek', 'anthropic', 'openai-compatible', 'studio', 'cli']) {
  const manifest = await readPackage(directory)
  const label = `${manifest.name ?? directory}`

  assert(publishablePackages.includes(manifest.name), `${label}: package name is not in the release set`)
  assert(manifest.private !== true, `${label}: publishable package must not be private`)
  assert(manifest.license === 'MIT', `${label}: license must be MIT`)
  assert(manifest.repository?.type === 'git', `${label}: repository.type must be git`)
  assert(manifest.repository?.url === repositoryUrl, `${label}: repository.url must be ${repositoryUrl}`)
  assert(
    manifest.repository?.directory === `packages/${directory}`,
    `${label}: repository.directory must be packages/${directory}`,
  )
  assert(manifest.homepage === homepageUrl, `${label}: homepage must be ${homepageUrl}`)
  assert(manifest.bugs?.url === bugsUrl, `${label}: bugs.url must be ${bugsUrl}`)
  assert(Array.isArray(manifest.files) && manifest.files.includes('dist'), `${label}: files must include dist`)
  assert(manifest.main === './dist/index.js', `${label}: main must be ./dist/index.js`)
  assert(manifest.types === './dist/index.d.ts', `${label}: types must be ./dist/index.d.ts`)
  assert(
    manifest.exports?.['.']?.types === './dist/index.d.ts' && manifest.exports?.['.']?.import === './dist/index.js',
    `${label}: exports["."] must expose dist types and import entries`,
  )

  const distEntry = join(packageRoot.pathname, directory, 'dist', 'index.js')
  assert(await exists(distEntry), `${label}: dist/index.js does not exist; run pnpm build first`)

  for (const [dependency, version] of Object.entries(manifest.dependencies ?? {})) {
    assert(!privateWorkspacePackages.has(dependency), `${label}: cannot depend on private package ${dependency}`)
    if (dependency.startsWith('@you-want/')) {
      assert(version === 'workspace:*', `${label}: workspace dependency ${dependency} must use workspace:*`)
    }
  }

  if (manifest.name === '@you-want/polyllm-cli') {
    assert(manifest.bin?.polyllm === './dist/main.js', `${label}: bin.polyllm must be ./dist/main.js`)
    assert(await exists(join(packageRoot.pathname, directory, 'dist', 'main.js')), `${label}: dist/main.js does not exist`)
    assert(
      await exists(join(packageRoot.pathname, directory, 'dist', 'studio-ui', 'index.html')),
      `${label}: dist/studio-ui/index.html does not exist; run pnpm build first`,
    )
  }
}

if (errors.length > 0) {
  console.error(`Package metadata validation failed:\n${errors.map((error) => `- ${error}`).join('\n')}`)
  process.exit(1)
}

console.log(`Validated ${publishablePackages.length} publishable packages.`)
