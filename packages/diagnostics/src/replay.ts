import { accumulateStream } from './accumulator.js'
import type {
  Anomaly,
  FaultLayer,
  Observation,
  Projection,
  StepName,
  StepStatus,
  Verdict,
} from './types.js'

export const REPORT_SCHEMA_VERSION = '0.1.0-draft'
export const REFERENCE_ACCUMULATOR = 'polyllm-reference'
export const PACKAGE_VERSION = '0.0.0'

const LIMITATIONS = [
  'Offline replay validates accumulation and detection logic against desensitized fixture events; it does not prove any live endpoint\'s current behavior.',
  'Reference accumulator is an independent implementation written from the OpenAI spec; it is not polyllm-core and must not be treated as polyllm-core\'s behavior witness.',
  'Fixture expectations are derived from public protocol documentation and desensitized public case reports; grades and provenance live in the fixture\'s evidenceGrade/source fields.',
] as const

export interface FixtureInput {
  request: {
    model?: string
    stream?: boolean
    tools?: unknown
    response_format?: unknown
  }
  sseEvents: string[]
}

export interface FixtureExpected {
  toolCalls?: Array<{ id: string; name: string; arguments: string }>
  contentText?: string
  finishReason?: string | null
  verdict?: Verdict
  anomalies?: Array<{ code: string; layer: FaultLayer; note?: string }>
}

export interface Fixture {
  caseId?: string
  title?: string
  source?: string
  evidenceGrade?: string
  input: FixtureInput
  expected: FixtureExpected
}

export interface DiagnoseReport {
  schemaVersion: string
  generatedAt: string
  mode: 'replay-offline'
  input: {
    fixture: string
    caseId: string | null
    title: string | null
    evidenceGrade: string | null
    source: string | null
  }
  subject: { accumulator: string; version: string }
  request: { model: string | null; stream: boolean; hasTools: boolean; hasResponseFormat: boolean }
  steps: Array<{ step: StepName; status: StepStatus }>
  projection: Projection
  anomalies: Anomaly[]
  observations: Observation[]
  verdict: Verdict
  comparison: {
    match: boolean
    checks: Array<{ field: string; ok: boolean; expected: unknown; actual: unknown }>
  } | null
  limitations: string[]
  evidence: { rawEvents: string[]; note: string }
}

function canonicalToolCalls(calls: Array<{ id: string; name: string; arguments: string }>): string {
  return JSON.stringify(calls.map((c) => ({ id: c.id, name: c.name, arguments: c.arguments })))
}

function canonicalAnomalies(codes: string[]): string {
  return JSON.stringify([...codes].sort())
}

export function replayFixture(fixture: Fixture, fixtureName: string): DiagnoseReport {
  const request = fixture.input.request
  const hasTools = Array.isArray(request.tools) && request.tools.length > 0
  const hasResponseFormat = request.response_format !== undefined && request.response_format !== null

  const result = accumulateStream(fixture.input.sseEvents, { hasTools, hasResponseFormat })
  const parseOk = !result.parseFailed
  const accumulateOk = parseOk

  const expected = fixture.expected
  const checks: Array<{ field: string; ok: boolean; expected: unknown; actual: unknown }> = []

  const expectedCalls = expected.toolCalls ?? []
  const actualCallsJson = canonicalToolCalls(result.toolCalls)
  const expectedCallsJson = canonicalToolCalls(expectedCalls)
  const callsOk = actualCallsJson === expectedCallsJson
  checks.push({ field: 'toolCalls', ok: callsOk, expected: expectedCalls, actual: result.toolCalls })

  const finishOk = (result.finishReason ?? null) === (expected.finishReason ?? null)
  checks.push({
    field: 'finishReason',
    ok: finishOk,
    expected: expected.finishReason ?? null,
    actual: result.finishReason,
  })

  const actualVerdict = result.verdict
  const verdictOk = expected.verdict === undefined || actualVerdict === expected.verdict
  if (expected.verdict !== undefined) {
    checks.push({ field: 'verdict', ok: verdictOk, expected: expected.verdict, actual: actualVerdict })
  }

  const expectedCodes = (expected.anomalies ?? []).map((a) => a.code)
  const actualCodes = result.anomalies.map((a) => a.code)
  const codesOk = canonicalAnomalies(actualCodes) === canonicalAnomalies(expectedCodes)
  if (expected.anomalies !== undefined) {
    checks.push({
      field: 'anomalyCodes',
      ok: codesOk,
      expected: [...expectedCodes].sort(),
      actual: [...actualCodes].sort(),
    })
  }

  const match = parseOk && accumulateOk && checks.every((c) => c.ok)

  const steps: Array<{ step: StepName; status: StepStatus }> = [
    { step: 'parse', status: parseOk ? 'pass' : 'fail' },
    { step: 'accumulate', status: accumulateOk ? 'pass' : 'fail' },
    { step: 'detect', status: 'pass' },
    { step: 'compare', status: checks.every((c) => c.ok) ? 'pass' : 'fail' },
  ]

  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    mode: 'replay-offline',
    input: {
      fixture: fixtureName,
      caseId: fixture.caseId ?? null,
      title: fixture.title ?? null,
      evidenceGrade: fixture.evidenceGrade ?? null,
      source: fixture.source ?? null,
    },
    subject: { accumulator: REFERENCE_ACCUMULATOR, version: PACKAGE_VERSION },
    request: {
      model: typeof request.model === 'string' ? request.model : null,
      stream: request.stream === true,
      hasTools,
      hasResponseFormat,
    },
    steps,
    projection: {
      toolCalls: result.toolCalls,
      contentText: result.contentText,
      finishReason: result.finishReason,
    },
    anomalies: result.anomalies,
    observations: result.observations,
    verdict: result.verdict,
    comparison: { match, checks },
    limitations: [...LIMITATIONS],
    evidence: {
      rawEvents: [...fixture.input.sseEvents],
      note: 'Raw SSE data lines preserved verbatim next to the projection; normalization must not delete detectable differences.',
    },
  }
}
