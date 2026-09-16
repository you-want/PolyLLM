import { readdir, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

const projectRoot = new URL('../', import.meta.url).pathname
const args = new Set(process.argv.slice(2))
const frozen = args.has('--frozen')
const expectedVersionArg = [...args].find((argument) => argument.startsWith('--version='))
const expectedVersion = expectedVersionArg?.slice('--version='.length)

const errors = []

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

async function collectWorkspacePackages() {
  const roots = ['packages', 'apps', 'examples']
  const packages = []

  for (const root of roots) {
    const directories = await readdir(join(projectRoot, root), { withFileTypes: true })
    for (const directory of directories) {
      if (!directory.isDirectory()) continue
      const packagePath = join(projectRoot, root, directory.name, 'package.json')
      if (!existsSync(packagePath)) continue
      const manifest = await readJson(packagePath)
      packages.push({ manifest, directory: join(root, directory.name) })
    }
  }

  return packages
}

function runPython(script, arguments_ = []) {
  const result = spawnSync('python3', [script, ...arguments_], {
    cwd: projectRoot,
    encoding: 'utf8',
  })
  if (result.status !== 0) {
    errors.push(`${script} failed:\n${result.stderr || result.stdout}`)
    return ''
  }
  return result.stdout.trim()
}

function parseChangeset(content, path) {
  const match = content.match(/^---\n([\s\S]*?)\n---/)
  if (!match) {
    errors.push(`${path}: missing changeset frontmatter`)
    return []
  }

  return match[1]
    .split('\n')
    .map((line) => line.match(/^["']?([^"' :]+)["']?:\s*(major|minor|patch)$/))
    .filter(Boolean)
    .map((match_) => ({ package: match_[1], releaseType: match_[2] }))
}

const rootManifest = await readJson(join(projectRoot, 'package.json'))
const workspacePackages = await collectWorkspacePackages()
const publishablePackages = workspacePackages.filter(({ manifest }) => manifest.private !== true)
const publishableNames = new Set(publishablePackages.map(({ manifest }) => manifest.name))
const expected = expectedVersion || rootManifest.version

if (!/^\d+\.\d+\.\d+$/.test(expected)) {
  errors.push(`Release version must use MAJOR.MINOR.PATCH format: ${expected}`)
}

for (const { manifest, directory } of publishablePackages) {
  if (manifest.version !== expected) {
    errors.push(`${manifest.name}: version ${manifest.version} does not match release version ${expected}`)
  }
  if (manifest.license !== 'MIT') {
    errors.push(`${manifest.name}: license must be MIT`)
  }
  if (!existsSync(join(projectRoot, directory, 'LICENSE'))) {
    errors.push(`${manifest.name}: package LICENSE is missing`)
  }
}

const pythonVersion = runPython('python/version.py', ['get'])
if (pythonVersion && pythonVersion !== expected) {
  errors.push(`Python packages: version ${pythonVersion} does not match release version ${expected}`)
}
runPython('python/version.py', ['check'])
runPython('python/verify_packages.py')

const changesetFiles = (await readdir(join(projectRoot, '.changeset'), { withFileTypes: true }))
  .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
  .map((entry) => entry.name)

if (frozen && changesetFiles.length > 0) {
  errors.push(`Release is not frozen; ${changesetFiles.length} changeset(s) remain: ${changesetFiles.join(', ')}`)
}

if (!frozen && changesetFiles.length === 0) {
  errors.push('No npm changesets are pending; run pnpm changeset before requesting a version PR')
}

let npmReleaseCount = 0
for (const file of changesetFiles) {
  const path = join(projectRoot, '.changeset', file)
  const releases = parseChangeset(await readFile(path, 'utf8'), file)
  npmReleaseCount += releases.length
  for (const release of releases) {
    if (!publishableNames.has(release.package)) {
      errors.push(`${file}: unknown or private npm package in changeset: ${release.package}`)
    }
  }
}

if (!frozen && npmReleaseCount === 0) {
  errors.push('Pending changesets do not release any publishable npm package')
}

for (const workflow of ['ci.yml', 'release-python.yml', 'release-npm.yml']) {
  if (!existsSync(join(projectRoot, '.github', 'workflows', workflow))) {
    errors.push(`Release workflow is missing: .github/workflows/${workflow}`)
  }
}

const npmReleaseWorkflowPath = join(projectRoot, '.github', 'workflows', 'release-npm.yml')
if (existsSync(npmReleaseWorkflowPath)) {
  const workflow = await readFile(npmReleaseWorkflowPath, 'utf8')
  for (const marker of ['publish-next', 'promote-latest', 'PUBLISH_NEXT', 'PROMOTE_LATEST']) {
    if (!workflow.includes(marker)) {
      errors.push(`release-npm.yml is missing safe release marker: ${marker}`)
    }
  }
}

const pythonReleaseWorkflowPath = join(projectRoot, '.github', 'workflows', 'release-python.yml')
if (existsSync(pythonReleaseWorkflowPath)) {
  const workflow = await readFile(pythonReleaseWorkflowPath, 'utf8')
  for (const marker of ['testpypi', 'pypi', 'PUBLISH_TESTPYPI', 'PUBLISH_PYPI', 'id-token: write']) {
    if (!workflow.includes(marker)) {
      errors.push(`release-python.yml is missing safe release marker: ${marker}`)
    }
  }
}

if (!existsSync(join(projectRoot, 'scripts', 'promote-npm-dist-tag.mjs'))) {
  errors.push('npm dist-tag promotion script is missing')
}

if (errors.length > 0) {
  console.error(`Release readiness validation failed:\n${errors.map((error) => `- ${error}`).join('\n')}`)
  process.exit(1)
}

console.log(
  [
    `Release readiness validated for version ${expected}.`,
    `Publishable npm packages: ${publishablePackages.length}.`,
    `Python package version: ${pythonVersion}.`,
    `Pending changesets: ${changesetFiles.length}.`,
    `Mode: ${frozen ? 'frozen release' : 'pre-release'}.`,
  ].join('\n'),
)
