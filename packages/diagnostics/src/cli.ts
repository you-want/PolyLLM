import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { replayFixture } from './replay.js'
import type { DiagnoseReport, Fixture } from './replay.js'

export interface RunDiagnoseOptions {
  fixturePath: string
  outDir?: string
  quiet?: boolean
}

export interface RunDiagnoseResult {
  exitCode: 0 | 1 | 2
  reports: DiagnoseReport[]
  reportDir: string | null
}

async function collectFixtureFiles(fixturePath: string): Promise<string[]> {
  const absolute = isAbsolute(fixturePath) ? fixturePath : resolve(fixturePath)
  const info = await stat(absolute)
  if (info.isDirectory()) {
    const entries = await readdir(absolute)
    return entries.filter((f) => f.endsWith('.json')).sort().map((f) => join(absolute, f))
  }
  return [absolute]
}

function printSummary(report: DiagnoseReport, quiet: boolean): void {
  if (quiet) {
    const mark = report.comparison?.match ? '✓' : '✗'
    console.log(`${mark} ${report.input.fixture} ${report.comparison?.match ? 'match' : 'mismatch'}`)
    return
  }
  const match = report.comparison?.match
  const mark = match ? '✓' : '✗'
  console.log(`${mark} ${report.input.fixture} [${report.input.caseId ?? '?'}] ${report.input.evidenceGrade ?? '?'}`)
  console.log(`  verdict: ${report.verdict}`)
  console.log(`  projection: ${report.projection.toolCalls.length} tool call(s), finish_reason=${report.projection.finishReason}`)
  if (report.anomalies.length > 0) {
    for (const a of report.anomalies) console.log(`  anomaly [${a.layer}] ${a.code} (${a.evidence})`)
  }
  if (report.observations.length > 0) {
    for (const o of report.observations) console.log(`  observation ${o.code} (${o.evidence})`)
  }
  if (!match && report.comparison) {
    for (const check of report.comparison.checks.filter((c) => !c.ok)) {
      console.log(`  mismatch on ${check.field}: expected=${JSON.stringify(check.expected)} actual=${JSON.stringify(check.actual)}`)
    }
  }
}

/** Offline fixture replay. No network, no credentials, no telemetry. */
export async function runDiagnose(options: RunDiagnoseOptions): Promise<RunDiagnoseResult> {
  let files: string[]
  try {
    files = await collectFixtureFiles(options.fixturePath)
  } catch (error) {
    console.error(`diagnose: 无法读取 fixture 路径: ${error instanceof Error ? error.message : error}`)
    return { exitCode: 2, reports: [], reportDir: null }
  }
  if (files.length === 0) {
    console.error('diagnose: 指定目录中没有 .json fixture 文件')
    return { exitCode: 2, reports: [], reportDir: null }
  }

  const reports: DiagnoseReport[] = []
  let exitCode: 0 | 1 = 0
  for (const file of files) {
    const name = basename(file)
    let fixture: Fixture
    try {
      fixture = JSON.parse(await readFile(file, 'utf8')) as Fixture
    } catch (error) {
      console.error(`diagnose: ${name} 不是合法 JSON: ${error instanceof Error ? error.message : error}`)
      return { exitCode: 2, reports, reportDir: null }
    }
    if (!Array.isArray(fixture.input?.sseEvents) || typeof fixture.expected !== 'object') {
      console.error(`diagnose: ${name} 缺少 input.sseEvents 或 expected，不是诊断 fixture`)
      return { exitCode: 2, reports, reportDir: null }
    }
    const report = replayFixture(fixture, name)
    reports.push(report)
    printSummary(report, options.quiet === true)
    if (!report.comparison?.match) exitCode = 1
  }

  const reportDir = resolve(options.outDir ?? 'polyllm-diagnostics-report')
  await mkdir(reportDir, { recursive: true })
  for (const report of reports) {
    const outName = report.input.fixture.replace(/\.json$/i, '.report.json')
    await writeFile(join(reportDir, outName), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  }
  if (!options.quiet) console.log(`报告已写入: ${reportDir}`)
  return { exitCode, reports, reportDir }
}
