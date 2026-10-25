import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { replayFixture } from '../src/replay.js'
import type { Fixture } from '../src/replay.js'

const fixtureDir = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures')

function loadRaw(name: string): Fixture {
  return JSON.parse(readFileSync(resolve(fixtureDir, name), 'utf8')) as Fixture
}

/** Rewrite one SSE event's JSON payload in place (keeps the `data: ` framing). */
function editChunk(fixture: Fixture, eventIndex: number, edit: (payload: Record<string, unknown>) => void): void {
  const raw = fixture.input.sseEvents[eventIndex]
  if (!raw?.startsWith('data: ')) throw new Error(`event ${eventIndex} is not a data line`)
  const payload = JSON.parse(raw.slice('data: '.length)) as Record<string, unknown>
  edit(payload)
  fixture.input.sseEvents[eventIndex] = `data: ${JSON.stringify(payload)}`
}

function mutate(name: string, mutateFn: (fixture: Fixture) => void): { name: string; fixture: Fixture } {
  const fixture = structuredClone(loadRaw(name)) as Fixture
  mutateFn(fixture)
  return { name, fixture }
}

/**
 * Mutation checks: every deliberately corrupted event must flip the replay
 * result away from the fixture's documented expectations. A mutation that
 * still "passes" means the checks are decorative.
 */
describe('mutation checks reject deliberately corrupted streams', () => {
  it('f1 mutation: null continuation id replaced by a real value pollutes attribution', () => {
    const { fixture } = mutate('f1-explicit-null-continuation.json', (f) => {
      f.input.sseEvents = f.input.sseEvents.map((e) => e.replace('"id":null', '"id":"call_zzz"'))
    })
    const report = replayFixture(fixture, 'f1-mutated')
    expect(report.comparison?.match).toBe(false)
    expect(report.verdict).not.toBe('pass')
  })

  it('f1 mutation: dropping an argument fragment breaks full-argument assembly', () => {
    const { fixture } = mutate('f1-explicit-null-continuation.json', (f) => {
      editChunk(f, 2, (payload) => {
        const entry = (payload.choices as Array<Record<string, unknown>>)[0] as unknown as {
          delta: { tool_calls: Array<{ function: { arguments: string } }> }
        }
        entry.delta.tool_calls[0].function.arguments = ''
      })
    })
    const report = replayFixture(fixture, 'f1-mutated')
    expect(report.comparison?.match).toBe(false)
  })

  it('f4 mutation: removing fragment ids makes attribution unrecoverable (verdict flips)', () => {
    const { fixture } = mutate('f4-parallel-constant-index.json', (f) => {
      for (const eventIndex of [1, 3]) {
        editChunk(f, eventIndex, (payload) => {
          const choice = (payload.choices as Array<Record<string, unknown>>)[0] as unknown as {
            delta: { tool_calls: Array<Record<string, unknown>> }
          }
          delete choice.delta.tool_calls[0].id
        })
      }
    })
    const report = replayFixture(fixture, 'f4-mutated')
    expect(report.verdict).toBe('upstream-noncompliant-unrecoverable')
    expect(report.comparison?.match).toBe(false)
  })

  it('f5 mutation: finish_reason "stop" removes the contradiction the fixture keys on', () => {
    const { fixture } = mutate('f5-args-leaked-as-content.json', (f) => {
      editChunk(f, 2, (payload) => {
        const choice = (payload.choices as Array<Record<string, unknown>>)[0] as unknown as {
          finish_reason: string
        }
        choice.finish_reason = 'stop'
      })
    })
    const report = replayFixture(fixture, 'f5-mutated')
    expect(report.anomalies.map((a) => a.code)).not.toContain('UPSTREAM_FINISH_WITHOUT_TOOLCALLS')
    expect(report.verdict).not.toBe('malformed-response')
    expect(report.comparison?.match).toBe(false)
  })

  it('f5 mutation: removing response_format removes the suspected request conflict evidence', () => {
    const { fixture } = mutate('f5-args-leaked-as-content.json', (f) => {
      delete f.input.request.response_format
    })
    const report = replayFixture(fixture, 'f5-mutated')
    expect(report.anomalies.map((a) => a.code)).not.toContain('REQUEST_FORMAT_TOOL_CONFLICT')
    expect(report.comparison?.match).toBe(false)
  })
})
