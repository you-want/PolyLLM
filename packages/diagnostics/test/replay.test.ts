import { readFileSync, readdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { replayFixture } from '../src/replay.js'
import type { Fixture } from '../src/replay.js'

const fixtureDir = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures')

function load(name: string): Fixture {
  return JSON.parse(readFileSync(resolve(fixtureDir, name), 'utf8')) as Fixture
}

const fixtureNames = readdirSync(fixtureDir).filter((f) => f.endsWith('.json')).sort()

describe('replay of D0 candidate fixtures', () => {
  for (const name of fixtureNames) {
    it(`replays ${name} in agreement with its documented expectations`, () => {
      const report = replayFixture(load(name), name)
      expect(report.comparison?.match, `mismatch checks: ${JSON.stringify(report.comparison?.checks)}`).toBe(true)
      expect(report.steps.every((s) => s.status === 'pass')).toBe(true)
    })
  }

  it('f1: explicit nulls are absence (observation, not anomaly) and the call assembles fully', () => {
    const report = replayFixture(load('f1-explicit-null-continuation.json'), 'f1')
    expect(report.verdict).toBe('pass')
    expect(report.anomalies).toHaveLength(0)
    expect(report.observations.map((o) => o.code)).toContain('OBS_EXPLICIT_NULL')
    expect(report.projection.toolCalls).toEqual([
      { id: 'call_a1b2c3', name: 'read_file', arguments: '{"path":"greeting.txt"}' },
    ])
  })

  it('f2: missing index is reported at the stream-parse layer and stays recoverable', () => {
    const report = replayFixture(load('f2-missing-toolcall-index.json'), 'f2')
    expect(report.verdict).toBe('upstream-noncompliant-recoverable')
    expect(report.anomalies.map((a) => a.code)).toEqual(['STREAM_PARSE_MISSING_INDEX'])
    expect(report.projection.toolCalls[0]).toMatchObject({ id: 'call_9z8y7x', name: 'get_weather' })
  })

  it('f3: a standard id-less continuation stream is clean — no false positives', () => {
    const report = replayFixture(load('f3-standard-idless-continuation.json'), 'f3')
    expect(report.verdict).toBe('pass')
    expect(report.anomalies).toHaveLength(0)
    expect(report.projection.toolCalls[0]?.arguments).toBe('{"city":"Paris"}')
  })

  it('f4: parallel calls with constant index recover by id and report both anomalies', () => {
    const report = replayFixture(load('f4-parallel-constant-index.json'), 'f4')
    expect(report.verdict).toBe('upstream-noncompliant-recoverable')
    expect(report.anomalies.map((a) => a.code).sort()).toEqual([
      'NORMALIZATION_ID_RESENT',
      'STREAM_PARSE_CONSTANT_INDEX',
    ])
    expect(report.projection.toolCalls).toHaveLength(2)
    expect(report.projection.toolCalls.map((c) => c.id)).toEqual(['call_p1', 'call_p2'])
  })

  it('f5: finish/tool_calls contradiction with leaked arguments is malformed-response', () => {
    const report = replayFixture(load('f5-args-leaked-as-content.json'), 'f5')
    expect(report.verdict).toBe('malformed-response')
    expect(report.anomalies.map((a) => a.code).sort()).toEqual([
      'NORMALIZATION_ARGS_IN_CONTENT',
      'REQUEST_FORMAT_TOOL_CONFLICT',
      'UPSTREAM_FINISH_WITHOUT_TOOLCALLS',
    ])
    expect(report.projection.toolCalls).toHaveLength(0)
    expect(report.projection.contentText).toBe('{"email":"a@b.c"}')
  })
})
