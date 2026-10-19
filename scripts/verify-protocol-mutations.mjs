/** A gate must reject corrupt input and corrupt expectations in both runtimes. */
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
const mutations = [
  ['stream-framing.json', c => c.id === 'sse-lf-split-event', c => { c.raw = 'INVALID SSE' }],
  ['stream-framing.json', c => c.id === 'sse-lf-split-event', c => { c.expectedChunks = [{ broken: true }] }],
  ['errors-timeout.json', c => c.id === 'http-401-auth', c => { c.error.category = 'server' }],
  ['models.json', c => c.id === 'aliased-model-resolves-to-canonical', c => { c.expectations.resolvedId = 'incorrect:model' }],
]
let checks = 0
for (const [file, select, mutate] of mutations) {
  const root = mkdtempSync(join(tmpdir(), 'polyllm-protocol-mutation-'))
  try {
    const fixtures = join(root, 'fixtures')
    cpSync('fixtures/protocol', fixtures, { recursive: true })
    const path = join(fixtures, file)
    const doc = JSON.parse(readFileSync(path, 'utf8'))
    mutate(doc.cases.find(select))
    writeFileSync(path, JSON.stringify(doc))
    for (const args of [[], ['--python']]) {
      const result = spawnSync(process.execPath, ['scripts/verify-protocol.mjs', ...args], { env: { ...process.env, POLYLLM_PROTOCOL_FIXTURES: fixtures, POLYLLM_PROTOCOL_OUTPUT: join(root, 'output') }, encoding: 'utf8' })
      assert.ok(result.status !== null && result.status !== 0, `${file} ${args}: corruption was accepted`)
      assert.ok((result.stderr + result.stdout).includes(doc.cases.find(select).id), `Mutation must fail at the mutated case: ${result.stderr}`)
      checks++
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
}
console.log(`Protocol mutation checks: ${checks} corruptions rejected`)
