import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const tag = process.argv[2]

if (!tag || !/^[a-z0-9][a-z0-9._-]*$/i.test(tag)) {
  console.error('Usage: node scripts/promote-npm-dist-tag.mjs <dist-tag>')
  process.exit(1)
}

const packages = readdirSync('packages')
  .map((directory) => join('packages', directory, 'package.json'))
  .filter((path) => existsSync(path))
  .map((path) => JSON.parse(readFileSync(path, 'utf8')))
  .filter((manifest) => manifest.private !== true)
  .sort((left, right) => left.name.localeCompare(right.name))

for (const manifest of packages) {
  const specification = `${manifest.name}@${manifest.version}`
  console.log(`Promoting ${specification} to ${tag}`)
  const result = spawnSync('npm', ['dist-tag', 'add', specification, tag], {
    stdio: 'inherit',
  })

  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}

console.log(`Promoted ${packages.length} packages to ${tag}.`)
