#!/usr/bin/env node
// Smoke test for scripts/promote-npm-dist-tag.mjs using a fake `npm` shim.
// The shim is driven by a JSON state file (registry state) and a counter file
// (how many dist-tag add attempts were made). Run: node scripts/test/promote-npm-dist-tag.test.mjs

import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const scriptPath = join(here, '..', 'promote-npm-dist-tag.mjs')

let failures = 0
function check(label, condition) {
  if (condition) console.log(`  ✓ ${label}`)
  else {
    console.log(`  ✗ ${label}`)
    failures += 1
  }
}

const HANDLER_SRC = `
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
const stateFile = process.env.FAKE_STATE_FILE
const counterFile = process.env.FAKE_COUNTER_FILE
const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : {}
function bump() {
  const n = existsSync(counterFile) ? parseInt(readFileSync(counterFile, 'utf8'), 10) : 0
  writeFileSync(counterFile, String(n + 1))
  return n
}
// The script invokes: npm view <name> versions  /  npm view <name> dist-tags.<tag>  /  npm dist-tag add <spec> <tag>
const args = process.argv.slice(2)
const cmd = args[0] ?? ''
const rest = args.slice(1)
if (cmd === 'view' && rest[1] === 'versions') {
  console.log(JSON.stringify(state.versions ?? []))
} else if (cmd === 'view' && rest[1]?.startsWith('dist-tags.')) {
  const tag = rest[1].slice('dist-tags.'.length)
  console.log(String(state['dist-tags.' + tag] ?? 'null'))
} else if (cmd === 'dist-tag') {
  const n = bump()
  if (n < (state.failUntil ?? 0)) {
    console.error('npm error 503 Service Unavailable - PUT ' + rest[0])
    process.exit(1)
  }
  console.log('added')
} else {
  console.error('unexpected', cmd, rest.join(' '))
  process.exit(1)
}
`

function setup(packages, state, tag = 'next') {
  const ws = mkdtempSync(join(tmpdir(), 'promote-test.'))
  for (const [name, version] of packages) {
    mkdirSync(join(ws, 'packages', name), { recursive: true })
    writeFileSync(join(ws, 'packages', name, 'package.json'), JSON.stringify({ name, version }))
  }
  const binDir = join(ws, '.bin')
  mkdirSync(binDir)
  const handler = join(ws, 'handler.mjs')
  writeFileSync(handler, HANDLER_SRC)
  const shim = join(binDir, 'npm')
  writeFileSync(
    shim,
    `#!/usr/bin/env node\n` +
      `import { spawn } from 'node:child_process'\n` +
      `const child = spawn(process.execPath, [process.env.FAKE_HANDLER, ...process.argv.slice(2)], { stdio: 'inherit' })\n` +
      `child.on('exit', (code) => process.exit(code ?? 0))\n`,
  )
  chmodSync(shim, 0o755)
  const stateFile = join(ws, 'state.json')
  const counterFile = join(ws, 'counter.txt')
  writeFileSync(stateFile, JSON.stringify(state))
  writeFileSync(counterFile, '0')
  return {
    ws,
    stateFile,
    counterFile,
    run(scriptArgs, extraEnv = {}) {
      const result = spawnSync(process.execPath, [scriptPath, ...scriptArgs], {
        cwd: ws,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH}`,
          FAKE_HANDLER: handler,
          FAKE_TAG: tag,
          FAKE_STATE_FILE: stateFile,
          FAKE_COUNTER_FILE: counterFile,
          ...extraEnv,
        },
      })
      return { status: result.status, stdout: result.stdout, stderr: result.stderr }
    },
    counter: () => readFileSync(counterFile, 'utf8').trim(),
  }
}

console.log('\n[1] already-set: tag already points to target → skip, exit 0')
{
  const t = setup([['pkg-a', '1.0.0']], { versions: ['1.0.0'], 'dist-tags.next': '1.0.0' })
  const r = t.run(['next'])
  check('exit 0', r.status === 0, r)
  check('reports already-set', r.stdout.includes('[already-set]'))
  check('no changes made', r.stdout.includes('no changes made'))
  check('dist-tag add never called', t.counter() === '0')
  rmSync(t.ws, { recursive: true, force: true })
}

console.log('\n[2] missing-version: target not on registry → exit 1')
{
  const t = setup([['pkg-b', '2.0.0']], { versions: ['1.0.0'], 'dist-tags.next': null })
  const r = t.run(['next'])
  check('exit 1', r.status === 1)
  check('reports missing-version', r.stdout.includes('[missing-version]'))
  check('explanatory detail', r.stdout.includes('is not published'))
  check('dist-tag add never called', t.counter() === '0')
  rmSync(t.ws, { recursive: true, force: true })
}

console.log('\n[3] version exists, tag unset → promote, exit 0')
{
  const t = setup([['pkg-c', '1.0.0']], { versions: ['1.0.0'], 'dist-tags.next': null })
  const r = t.run(['next'])
  check('exit 0', r.status === 0, r)
  check('reports ok', r.stdout.includes('[ok]'))
  check('dist-tag add called once', t.counter() === '1')
  rmSync(t.ws, { recursive: true, force: true })
}

console.log('\n[4] transient 503: retries until success (failUntil=2, retries=3)')
{
  const t = setup([['pkg-d', '1.0.0']], { versions: ['1.0.0'], 'dist-tags.next': null, failUntil: 2 })
  const r = t.run(['next', '--retries=3'])
  check('exit 0 after retries', r.status === 0, r)
  check('reports ok', r.stdout.includes('[ok]'))
  check('3 attempts (2 fail + 1 success)', t.counter() === '3')
  rmSync(t.ws, { recursive: true, force: true })
}

console.log('\n[5] all retries exhausted (failUntil=999, retries=2) → exit 1')
{
  const t = setup([['pkg-e', '1.0.0']], { versions: ['1.0.0'], 'dist-tags.next': null, failUntil: 999 })
  const r = t.run(['next', '--retries=2'])
  check('exit 1', r.status === 1)
  check('reports error', r.stdout.includes('[error]'))
  check('3 attempts (1 initial + 2 retries)', t.counter() === '3')
  rmSync(t.ws, { recursive: true, force: true })
}

console.log('\n[6] dry-run: no dist-tag add, reports would-promote')
{
  const t = setup([['pkg-f', '1.0.0']], { versions: ['1.0.0'], 'dist-tags.next': null })
  const r = t.run(['next', '--dry-run'])
  check('exit 0', r.status === 0, r)
  check('reports dry-run', r.stdout.includes('[dry-run]'))
  check('dist-tag add never called', t.counter() === '0')
  rmSync(t.ws, { recursive: true, force: true })
}

console.log(`\n${failures === 0 ? 'All tests passed' : `${failures} test(s) failed`}`)
process.exit(failures === 0 ? 0 : 1)
