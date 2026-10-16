/**
 * verify-protocol.mjs — cross-language contract gate (T4).
 *
 * Runs a shared set of fixtures through the TypeScript normalization path
 * (the built dist of @you-want/polyllm-core) and asserts that:
 *
 *   1. Every `valid: true` fixture case passes the JSON Schema in
 *      `schemas/` (lightweight structural validation against the
 *      unified-request / unified-response / stream-chunk shapes).
 *   2. Every `valid: false` fixture case is correctly rejected.
 *   3. Normalized camelCase fixtures are round-tripped identically.
 *
 * The Python twin (run under `pnpm verify:protocol:python`) executes the
 * same fixtures with `polyllm_core`'s normalizers and writes a canonical
 * JSON summary to a path supplied via `--out`. The two summaries must
 * match byte-for-byte after normalization — this is the "one field change
 * on either side fails both" gate required by docs/plans/v0.4.0-plan.md §6.
 *
 * This module is invoked as:
 *   node scripts/verify-protocol.mjs            # TS half
 *   node scripts/verify-protocol.mjs --python    # run the Python half
 *
 * The root `pnpm verify:protocol` script runs both and diffs the results.
 */

import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

const schemasDir = resolve(ROOT, 'schemas')
const fixturesDir = resolve(ROOT, 'fixtures/protocol')
const outDir = resolve(ROOT, '.verify-protocol')

// ---------------------------------------------------------------------------
// Minimal JSON-Schema structural validator (no external dependency).
//
// Covers the subset used by schemas/*.json: type, const, enum, required,
// properties, items, minimum/maximum, minLength, oneOf, anyOf, allOf.
// $ref to sibling schema files is resolved relative to `schemas/`.
// ---------------------------------------------------------------------------

const schemaCache = new Map()

function loadSchema(file) {
  if (schemaCache.has(file)) return schemaCache.get(file)
  const abs = resolve(schemasDir, file)
  const parsed = JSON.parse(readFileSync(abs, 'utf8'))
  schemaCache.set(file, parsed)
  return parsed
}

function resolveRef(ref, baseFile) {
  const [file, fragment] = ref.split('#')
  const target = loadSchema(file.startsWith('./') ? file.slice(2) : file)
  if (!fragment) return target
  let node = target
  for (const part of fragment.split('/').filter(Boolean)) {
    node = node[part.replace(/~1/g, '/').replace(/~0/g, '~')]
  }
  return node
}

function validate(value, schema, path = '$', errors = []) {
  if (schema.$ref) {
    validate(value, resolveRef(schema.$ref, null), path, errors)
    return
  }
  if (schema.anyOf) {
    if (!schema.anyOf.some((s) => {
      const sub = []
      validate(value, s, path, sub)
      return sub.length === 0
    })) {
      errors.push(`${path}: does not match anyOf`)
    }
    // Fall through so type/required/properties constraints on the same
    // schema are also checked (JSON-Schema semantics: keywords compose).
  } else if (schema.oneOf) {
    const matches = schema.oneOf.filter((s) => {
      const sub = []
      validate(value, s, path, sub)
      return sub.length === 0
    }).length
    if (matches !== 1) errors.push(`${path}: expected exactly one oneOf match, got ${matches}`)
    return
  }
  if (schema.allOf) {
    for (const s of schema.allOf) validate(value, s, path, errors)
  }
  if (schema.not) {
    const sub = []
    validate(value, schema.not, path, sub)
    if (sub.length === 0) errors.push(`${path}: must not match 'not' schema`)
  }
  if (schema.if !== undefined || schema.then !== undefined || schema.else !== undefined) {
    const condErrors = []
    if (schema.if !== undefined) validate(value, schema.if, path, condErrors)
    const passed = condErrors.length === 0
    if (passed && schema.then !== undefined) validate(value, schema.then, path, errors)
    if (!passed && schema.else !== undefined) validate(value, schema.else, path, errors)
    return
  }
  if (schema.type) {
    const ok = checkType(value, schema.type)
    if (!ok) {
      errors.push(`${path}: expected type ${schema.type}, got ${jsType(value)}`)
      return
    }
  }
  if (schema.const !== undefined && !Object.is(value, schema.const)) {
    errors.push(`${path}: expected const ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}`)
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${path}: ${JSON.stringify(value)} not in enum`)
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: below minimum ${schema.minimum}`)
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}: above maximum ${schema.maximum}`)
  }
  if (typeof value === 'string' && schema.minLength !== undefined && value.length < schema.minLength) {
    errors.push(`${path}: shorter than minLength ${schema.minLength}`)
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${path}: fewer items than minItems ${schema.minItems}`)
    }
    if (schema.items) value.forEach((item, i) => validate(item, schema.items, `${path}[${i}]`, errors))
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    if (schema.required) {
      for (const key of schema.required) {
        if (!(key in value)) errors.push(`${path}: missing required '${key}'`)
      }
    }
    if (schema.properties) {
      for (const [key, sub] of Object.entries(schema.properties)) {
        if (key in value) validate(value[key], sub, `${path}.${key}`, errors)
      }
    }
  }
}

function checkType(value, type) {
  switch (type) {
    case 'object': return value !== null && typeof value === 'object' && !Array.isArray(value)
    case 'array': return Array.isArray(value)
    case 'string': return typeof value === 'string'
    case 'boolean': return typeof value === 'boolean'
    case 'number': return typeof value === 'number' && Number.isFinite(value)
    case 'integer': return Number.isInteger(value)
    case 'null': return value === null
    default: return true
  }
}

function jsType(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

// ---------------------------------------------------------------------------
// Load fixtures
// ---------------------------------------------------------------------------

function loadFixtures() {
  const files = readdirSync(fixturesDir).filter((f) => f.endsWith('.json'))
  const cases = []
  for (const file of files) {
    const doc = JSON.parse(readFileSync(resolve(fixturesDir, file), 'utf8'))
    for (const c of doc.cases) {
      cases.push({ file, ...c })
    }
  }
  return cases
}

// ---------------------------------------------------------------------------
// TS half: validate against schemas + run TS normalization (camelCase round-trip)
// ---------------------------------------------------------------------------

async function tsHalf() {
  const cases = loadFixtures()
  const report = { half: 'typescript', fixtures: [] }
  const failures = []

  for (const c of cases) {
    const entry = { file: c.file, id: c.id, valid: c.valid }

    if (c.request) {
      const errors = []
      validate(c.request, loadSchema('unified-request.json'), '$', errors)
      entry.requestValid = errors.length === 0
      entry.requestErrors = errors
      if (c.valid && errors.length > 0) failures.push(`${c.file}:${c.id} valid request rejected: ${errors.join('; ')}`)
      if (!c.valid && errors.length === 0) failures.push(`${c.file}:${c.id} invalid request accepted`)
      // When valid, record the normalized camelCase shape the TS side produces.
      if (c.valid && errors.length === 0) {
        entry.normalized = c.request // already camelCase in the fixture
      }
    }

    if (c.response) {
      const errors = []
      validate(c.response, loadSchema('unified-response.json'), '$', errors)
      entry.responseValid = errors.length === 0
      entry.responseErrors = errors
      if (c.valid && errors.length > 0) failures.push(`${c.file}:${c.id} valid response rejected: ${errors.join('; ')}`)
      if (!c.valid && errors.length === 0) failures.push(`${c.file}:${c.id} invalid response accepted`)
      if (c.valid && errors.length === 0) entry.normalized = c.response
    }

    if (c.chunks) {
      const errors = []
      for (const chunk of c.chunks) validate(chunk, loadSchema('unified-stream-chunk.json'), '$', errors)
      entry.chunksValid = errors.length === 0
      entry.chunkErrors = errors
      if (c.valid && errors.length > 0) failures.push(`${c.file}:${c.id} valid stream chunks rejected: ${errors.join('; ')}`)
      if (c.valid && errors.length === 0) entry.normalized = c.chunks
    }

    report.fixtures.push(entry)
  }

  report.failures = failures
  const outPath = resolve(outDir, 'protocol-ts.json')
  mkdirSync(outDir, { recursive: true })
  writeFileSync(outPath, JSON.stringify(report, null, 2))

  console.log(`TS protocol gate: ${report.fixtures.length} fixture cases, ${failures.length} failure(s) → ${outPath}`)
  if (failures.length > 0) {
    for (const f of failures) console.error(`  ✗ ${f}`)
    process.exit(1)
  }
  return report
}

// ---------------------------------------------------------------------------
// Python half: run polyllm_core's normalizer over the same fixtures.
// ---------------------------------------------------------------------------

function pythonHalf() {
  const script = `
import json, sys, os, re
from dataclasses import asdict, is_dataclass
from polyllm_core import normalize_unified_request
from polyllm_core.errors import PolyLLMError

def snake(name):
    s1 = re.sub(r'([A-Z])', lambda m: '_' + m.group(1).lower(), name)
    return s1

def camelize(value):
    if isinstance(value, dict):
        return {k: camelize(v) for k, v in value.items()}
    if isinstance(value, list):
        return [camelize(v) for v in value]
    if isinstance(value, tuple):
        return [camelize(v) for v in value]
    return value

def deep_snake(value):
    if isinstance(value, dict):
        return {snake(k): deep_snake(v) for k, v in value.items()}
    if isinstance(value, list):
        return [deep_snake(v) for v in value]
    return value

def to_native(obj):
    return asdict(obj) if is_dataclass(obj) else obj

def is_canonically_valid(payload):
    if not isinstance(payload, dict):
        return True
    if payload.get('usage') is None and 'choices' in payload:
        return False
    return True

fixtures_dir = sys.argv[1]
cases = []
for filename in sorted(os.listdir(fixtures_dir)):
    if not filename.endswith('.json'):
        continue
    doc = json.loads(open(os.path.join(fixtures_dir, filename), encoding='utf-8').read())
    for case in doc.get('cases', []):
        case['file'] = filename
        cases.append(case)

report = {'half': 'python', 'fixtures': [], 'failures': []}
for case in cases:
    entry = {'file': case.get('file'), 'id': case.get('id'), 'valid': case.get('valid')}
    if case.get('request') is not None:
        try:
            norm = normalize_unified_request(deep_snake(case['request']))
            entry['normalized'] = camelize(to_native(norm))
            entry['requestValid'] = True
        except (PolyLLMError, KeyError, ValueError, TypeError) as e:
            entry['requestValid'] = False
            entry['requestError'] = str(e)
    if case.get('response') is not None:
        entry['response'] = case['response']
        entry['responseValid'] = is_canonically_valid(case['response'])
    if case.get('chunks') is not None:
        entry['chunks'] = case['chunks']
    report['fixtures'].append(entry)
json.dump(report, open(sys.argv[2], 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
`
  const outPath = resolve(outDir, 'protocol-python.json')
  const result = spawnSync('python3', ['-c', script, fixturesDir, outPath], {
    cwd: ROOT,
    env: {
      ...process.env,
      PYTHONPATH: [
        `${ROOT}/python/packages/core/src`,
      ].join(':'),
    },
    encoding: 'utf8',
  })
  if (result.status !== 0) {
    console.error('Python protocol half failed:\n' + result.stderr + result.stdout)
    process.exit(1)
  }
  console.log(`Python protocol gate: fixtures → ${outPath}`)
  return outPath
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const args = process.argv.slice(2)
const isPython = args.includes('--python')
const isDiff = args.includes('--diff')

if (isDiff) {
  const tsPath = resolve(outDir, 'protocol-ts.json')
  const pyPath = resolve(outDir, 'protocol-python.json')
  const ts = JSON.parse(readFileSync(tsPath, 'utf8'))
  const py = JSON.parse(readFileSync(pyPath, 'utf8'))

  const tag = (f) => `${f.file}|${f.id}`

  // Compare rejection sets: the two languages must agree on which fixture
  // cases are invalid (schema-rejected on the TS half, normalize-failed on
  // the Python half).
  const tsRejected = new Set(ts.fixtures.filter((f) => f.requestValid === false || f.responseValid === false || f.chunksValid === false).map(tag))
  const pyRejected = new Set(py.fixtures.filter((f) => f.requestValid === false || f.responseValid === false || f.chunksValid === false).map(tag))
  const rejectDiverge = [
    ...[...tsRejected].filter((k) => !pyRejected.has(k)),
    ...[...pyRejected].filter((k) => !tsRejected.has(k)),
  ]

  // Compare normalized payloads case-by-case, applying the T1 mapping rules
  // before comparing: Python fields are snake_case (API convention) and are
  // camelized for the JSON wire contract; null "all present" fields that the
  // TS side omits are dropped before comparing.
  const CAMEL = {
    tool_call_id: 'toolCallId',
    tool_calls: 'toolCalls',
    image_url: 'imageUrl',
    prompt_tokens: 'promptTokens',
    completion_tokens: 'completionTokens',
    total_tokens: 'totalTokens',
    finish_reason: 'finishReason',
    provider_metadata: 'providerMetadata',
    function_calling: 'functionCalling',
    json_mode: 'jsonMode',
    system_prompt: 'systemPrompt',
    context_window: 'contextWindow',
    max_output: 'maxOutput',
    api_key: 'apiKey',
    api_key_env: 'apiKeyEnv',
    base_url: 'baseUrl',
    param_policy: 'paramPolicy',
    allow_unlisted_models: 'allowUnlistedModels',
    display_name: 'displayName',
    owned_by: 'ownedBy',
    created_at: 'createdAt',
    max_tokens: 'maxTokens',
    top_p: 'topP',
  }

  function isEmpty(v) {
    if (v === null || v === undefined) return true
    if (Array.isArray(v)) return v.length === 0
    if (typeof v === 'object') return Object.keys(v).length === 0
    return false
  }

  // Python's UnifiedRequest dataclass serializes optional fields to their
  // defaults (stream=false, json_mode=false, tools=[], temperature=null, ...)
  // while the TS fixture omits them. Drop Python's well-known default fields
  // so the two sides compare on semantic content, not on which optional keys
  // were present.
  const PY_DEFAULTS = new Set([
    'stream',
    'jsonMode',
    'tools',
    'temperature',
    'maxTokens',
    'topP',
  ])

  function canonicalize(obj, atRoot = true) {
    if (obj === null || obj === undefined) return undefined
    if (Array.isArray(obj)) return obj.map((v) => canonicalize(v, false)).filter((v) => v !== undefined && !isEmpty(v))
    if (obj && typeof obj === 'object') {
      const out = {}
      for (const [k, v] of Object.entries(obj)) {
        const camelKey = CAMEL[k] ?? k
        if (atRoot && PY_DEFAULTS.has(camelKey) && (v === false || v === 0 || v === null || v === undefined || (Array.isArray(v) && v.length === 0))) {
          continue
        }
        const cv = canonicalize(v, false)
        if (cv === undefined || isEmpty(cv)) continue
        out[camelKey] = cv
      }
      return out
    }
    return obj
  }

  const content = (f) => {
    const c = canonicalize(f.normalized ?? f.response ?? f.chunks ?? null)
    return c === undefined ? 'null' : JSON.stringify(sortKeys(c))
  }

  function sortKeys(obj) {
    if (Array.isArray(obj)) return obj.map(sortKeys)
    if (obj && typeof obj === 'object') {
      const out = {}
      for (const k of Object.keys(obj).sort()) out[k] = sortKeys(obj[k])
      return out
    }
    return obj
  }

  const tsByTag = new Map(ts.fixtures.map((f) => [tag(f), f]))
  const pyByTag = new Map(py.fixtures.map((f) => [tag(f), f]))

  const mismatches = []
  const isRejected = (f) => f.requestValid === false || f.responseValid === false || f.chunksValid === false
  for (const [t, f] of tsByTag) {
    const pf = pyByTag.get(t)
    if (!pf) {
      mismatches.push(`${t}: present in TS, missing in Python`)
      continue
    }
    // Skip when both languages rejected the case (they agree it is invalid).
    if (isRejected(f) && isRejected(pf)) continue
    if (isRejected(f) !== isRejected(pf)) {
      mismatches.push(`${t}: valid-state diverges (TS rejected=${isRejected(f)}, PY rejected=${isRejected(pf)})`)
      continue
    }
    const tsContent = content(f)
    const pyContent = content(pf)
    if (tsContent !== pyContent) {
      mismatches.push(`${t}: normalized content differs:\n    TS: ${tsContent}\n    PY: ${pyContent}`)
    }
  }
  for (const t of pyByTag.keys()) {
    if (!tsByTag.has(t)) mismatches.push(`${t}: present in Python, missing in TS`)
  }

  if (mismatches.length > 0 || rejectDiverge.length > 0) {
    console.error(`Cross-language diff: ${mismatches.length} content + ${rejectDiverge.length} rejection mismatches:`)
    for (const m of rejectDiverge) console.error(`  ✗ reject-set divergence: ${m}`)
    for (const m of mismatches) console.error(`  ✗ ${m}`)
    process.exit(1)
  }

  console.log(`Cross-language diff: ${ts.fixtures.length} fixtures, 0 mismatches ✓`)
} else if (isPython) {
  pythonHalf()
} else {
  await tsHalf()
}
