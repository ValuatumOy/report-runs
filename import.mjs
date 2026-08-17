import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getObject } from './s3.mjs'

/**
 * Imports a worker run (test or production) from its Langfuse trace + the S3
 * artifacts the worker persisted.
 *
 *   node import.mjs --list [--company TSLA] [--limit 20] [--test]
 *   node import.mjs <traceId> [--test] [--note "..."]
 *
 * Worker runs are the only ones with server-side prompt versions: the trace is
 * ground truth (see the engine's docs/prompt-environments.md). PDF and
 * snapshot come from S3, so this needs AWS credentials — AWS_PROFILE=valuatum-pdf
 * locally, or AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY in an environment that
 * has no AWS CLI.
 */

const ROOT = dirname(fileURLToPath(import.meta.url))
const HOST = 'https://cloud.langfuse.com'

// Langfuse credentials live in the engine repo's .env; no second copy here.
const envPath = process.env.PDF_ENGINE_ENV ?? join(ROOT, '..', 'pdf-report-engine', '.env')
const env = { ...process.env }
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim())
    if (m && !env[m[1]]) env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
}
if (!env.LANGFUSE_PUBLIC_KEY) throw new Error(`no LANGFUSE_PUBLIC_KEY (looked in ${envPath})`)
const AUTH = 'Basic ' + Buffer.from(`${env.LANGFUSE_PUBLIC_KEY}:${env.LANGFUSE_SECRET_KEY}`).toString('base64')

const argv = process.argv.slice(2)
const flag = (name) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : undefined
}
// A trace doesn't say which stack ran it, so try production first and fall
// back to the test bucket; whichever holds the artifacts names the source.
const BUCKETS = argv.includes('--test')
  ? [['test', 'valuatum-pdf-reports-test']]
  : [
      ['prod', 'valuatum-pdf-reports'],
      ['test', 'valuatum-pdf-reports-test'],
    ]

const api = async (path) => {
  const res = await fetch(`${HOST}/api/public/${path}`, { headers: { Authorization: AUTH } })
  if (!res.ok) throw new Error(`langfuse ${path}: ${res.status} ${await res.text()}`)
  return res.json()
}

if (argv.includes('--list')) {
  const company = flag('company')
  const range =
    (flag('from') ? `&fromTimestamp=${flag('from')}T00:00:00Z` : '') +
    (flag('to') ? `&toTimestamp=${flag('to')}T23:59:59Z` : '')
  const { data } = await api(`traces?limit=${flag('limit') ?? '20'}&name=resolve_render:osakeanalyysi${range}`)
  for (const t of data) {
    const m = t.metadata ?? {}
    if (company && m.companyCode !== company) continue
    console.log(`${t.id}  ${t.timestamp.slice(0, 16)}  ${String(m.companyCode).padEnd(9)} ${m.lang}  job=${m.jobId}`)
  }
  process.exit(0)
}

const traceId = argv.find((a, i) => !a.startsWith('--') && argv[i - 1] !== '--note' && argv[i - 1] !== '--company' && argv[i - 1] !== '--limit')
if (!traceId) {
  console.error('usage: node import.mjs <traceId> [--test] [--note "..."]   |   --list [--company TSLA]')
  process.exit(2)
}

const trace = await api(`traces/${traceId}`)
const meta = trace.metadata ?? {}
if (!meta.jobId) throw new Error(`trace ${traceId} carries no jobId — not a worker run`)

const obs = (await api(`observations?traceId=${traceId}&limit=100`)).data
const prompts = [
  ...new Map(obs.filter((o) => o.promptName).map((o) => [o.promptName, { name: o.promptName, version: `v${o.promptVersion}` }])).values(),
].sort((a, b) => a.name.localeCompare(b.name))
const pipeline = prompts.some((p) => p.name.startsWith('osakeanalyysi-sw.')) ? 'single-writer' : 'multi-stage'
const runId = `${trace.timestamp.replace(/[:.]/g, '-').slice(0, 19)}Z__${meta.companyCode ?? 'unknown'}__${pipeline}`
const dir = join(ROOT, 'runs', runId)
mkdirSync(dir, { recursive: true })

const pull = async (bucket, key, out) => {
  const body = await getObject(bucket, key)
  if (!body) return false
  writeFileSync(out, body)
  return true
}
let source = 'unknown'
let gotSnapshot = false
for (const [name, bucket] of BUCKETS) {
  const pdf = await pull(bucket, `${meta.jobId}.pdf`, join(dir, 'report.pdf'))
  const snap = await pull(bucket, `artifacts/${meta.jobId}.snapshot.json`, join(dir, 'snapshot.json'))
  if (pdf || snap) {
    source = name
    gotSnapshot = snap
    break
  }
}
if (source === 'unknown') {
  // Leaving a metadata-only folder behind would put this trace in the registry's
  // "already imported" set, so a later pass with working credentials would skip
  // it forever. Better to record nothing and let the next run try again.
  rmSync(dir, { recursive: true, force: true })
  console.warn(`! no artifacts for job ${meta.jobId} in ${BUCKETS.map(([, b]) => b).join(' or ')} — nothing recorded, will retry`)
  process.exit(3)
}

let rec = {}
if (gotSnapshot) {
  const snap = JSON.parse(readFileSync(join(dir, 'snapshot.json'), 'utf8'))
  writeFileSync(join(dir, 'snapshot.json'), JSON.stringify(snap, null, 2))
  rec = snap?.narrativeCache?.data?.recommendation ?? {}
}

writeFileSync(
  join(dir, 'meta.json'),
  JSON.stringify(
    {
      runId,
      createdAt: trace.timestamp,
      source,
      reportId: 'osakeanalyysi',
      company: meta.companyCode,
      lang: meta.lang,
      currency: meta.currency,
      country: meta.country,
      pipeline,
      models: [...new Set(obs.map((o) => o.model).filter(Boolean))].sort(),
      promptStore: `langfuse:${source === 'test' ? 'staging' : 'production'}`,
      prompts,
      langfuseTraceId: traceId,
      jobId: meta.jobId,
      costUsd: Number(obs.reduce((s, o) => s + (o.calculatedTotalCost ?? 0), 0).toFixed(6)),
      llmCalls: obs.filter((o) => o.type === 'GENERATION').length,
      durationSec: trace.latency != null ? Math.round(trace.latency) : undefined,
      rating: rec.rating,
      targetPrice: rec.targetPrice,
      currentPrice: rec.currentPrice,
      upsidePct: rec.upsidePct,
      note: flag('note'),
    },
    null,
    2,
  ) + '\n',
)
console.log(`→ runs/${runId}  (${pipeline}, ${prompts.length} prompts)`)
