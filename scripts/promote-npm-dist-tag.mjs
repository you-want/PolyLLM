import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// Promote all publishable workspace packages to a dist-tag with:
//   - preflight: verify the target version actually exists on the registry
//     before moving any tag (catches "publish failed but we didn't notice")
//   - per-package status: ok / already-set / missing-version / error
//   - transient-error retry with backoff (5xx / E503) for dist-tag adds only
//   - idempotent re-runs: already-set packages are skipped, not treated as failure
//   - exit 0 only when every package reaches the target tag state
//
// Usage: node scripts/promote-npm-dist-tag.mjs <dist-tag> [--dry-run] [--retries 3]

const argv = process.argv.slice(2)
const tag = argv[0]
const dryRun = argv.includes('--dry-run')
const retriesArg = argv.find((arg) => arg.startsWith('--retries='))
const maxRetries = retriesArg ? Number(retriesArg.slice('--retries='.length)) : 3

if (!tag || !/^[a-z0-9][a-z0-9._-]*$/i.test(tag)) {
  console.error('Usage: node scripts/promote-npm-dist-tag.mjs <dist-tag> [--dry-run] [--retries=3]')
  process.exit(1)
}
if (!Number.isInteger(maxRetries) || maxRetries < 0) {
  console.error(`Invalid --retries value: ${retriesArg ?? 3}`)
  process.exit(1)
}

const packages = readdirSync('packages')
  .map((directory) => join('packages', directory, 'package.json'))
  .filter((path) => existsSync(path))
  .map((path) => JSON.parse(readFileSync(path, 'utf8')))
  .filter((manifest) => manifest.private !== true)
  .sort((left, right) => left.name.localeCompare(right.name))

function runNpm(args) {
  return spawnSync('npm', args, { encoding: 'utf8' })
}

function versionExists(name, version) {
  const result = runNpm(['view', name, 'versions', '--json'])
  if (result.status !== 0) return { exists: false, error: result.stderr?.trim() || result.stdout?.trim() }
  try {
    const versions = JSON.parse(result.stdout)
    return { exists: Array.isArray(versions) && versions.includes(version), error: '' }
  } catch (error) {
    return { exists: false, error: error.message }
  }
}

function currentDistTag(name, distTag) {
  // Use the 2-arg form `npm view <name> dist-tags.<tag>` so tests can drive
  // it with a fake shim; the registry's response is a bare version or `null`.
  const result = runNpm(['view', name, `dist-tags.${distTag}`])
  if (result.status !== 0) return { value: null, error: result.stderr?.trim() || '' }
  const value = result.stdout.trim()
  return { value: value && value !== 'null' ? value.replace(/"/g, '') : null, error: '' }
}

function addDistTag(name, version, distTag) {
  return runNpm(['dist-tag', 'add', `${name}@${version}`, distTag])
}

function isTransient(result) {
  // 5xx and service-unavailable are retryable; 403/409 are not.
  const text = `${result.stdout ?? ''} ${result.stderr ?? ''}`
  return /E503|E502|E500|Service Unavailable|503 Service Unavailable/i.test(text)
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function promoteOne(manifest, retryBudget) {
  const specification = `${manifest.name}@${manifest.version}`
  const existing = currentDistTag(manifest.name, tag)
  if (existing.value === manifest.version) {
    return { name: manifest.name, status: 'already-set', detail: `dist-tag ${tag} already points to ${manifest.version}` }
  }
  if (dryRun) {
    return {
      name: manifest.name,
      status: 'dry-run',
      detail: `would promote ${specification} to ${tag} (current: ${existing.value ?? 'none'})`,
    }
  }
  const existence = versionExists(manifest.name, manifest.version)
  if (!existence.exists) {
    return {
      name: manifest.name,
      status: 'missing-version',
      detail: `${manifest.version} is not published on the registry${existence.error ? ` (${existence.error})` : ''}`,
    }
  }

  let lastResult = null
  for (let attempt = 0; attempt <= retryBudget; attempt += 1) {
    if (attempt > 0) await delay(Math.min(1000 * 2 ** attempt, 8000))
    lastResult = addDistTag(manifest.name, manifest.version, tag)
    if (lastResult.status === 0) return { name: manifest.name, status: 'ok', detail: `promoted ${specification} to ${tag}` }
    if (!isTransient(lastResult)) break
  }

  const output = `${lastResult?.stdout ?? ''}\n${lastResult?.stderr ?? ''}`.trim()
  return {
    name: manifest.name,
    status: 'error',
    detail: output || `npm dist-tag add failed (exit ${lastResult?.status})`,
  }
}

async function main() {
  console.log(`Promoting ${packages.length} packages to ${tag}${dryRun ? ' (dry-run)' : ''}`)
  const results = []
  for (const manifest of packages) {
    const result = await promoteOne(manifest, maxRetries)
    results.push(result)
    console.log(`[${result.status}] ${result.name}: ${result.detail}`)
  }

  const failures = results.filter((result) => result.status === 'error' || result.status === 'missing-version')
  const ok = results.filter((result) => result.status === 'ok' || result.status === 'already-set' || result.status === 'dry-run')

  console.log(`\nSummary: ${ok.length} succeeded, ${failures.length} failed.`)
  if (failures.length > 0) {
    console.error('\nFailed packages:')
    for (const failure of failures) console.error(`  [${failure.status}] ${failure.name}: ${failure.detail}`)
    process.exitCode = 1
    return
  }
  if (!dryRun && results.every((result) => result.status === 'already-set')) {
    console.log('All packages were already at the target tag; no changes made.')
  } else {
    console.log(`Promoted ${packages.length} packages to ${tag}.`)
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
