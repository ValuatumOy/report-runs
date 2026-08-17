import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Imports a worker run (test or production) from its Langfuse trace + the S3
 * artifacts the worker persisted.
 *
 *   node import.mjs --list [--company TSLA] [--limit 20] [--test]
 *   node import.mjs <traceId> [--test] [--note "..."]
 *
 * Worker runs are the only ones with server-side prompt versions: the trace is
 * ground truth (see the engine's docs/prompt-environments.md). PDF and
 * snapshot come from S3, so this needs AWS_PROFILE=valuatum-pdf.
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
const isTest = argv.includes('--test')
const BUCKET = isTest ? 'valuatum-pdf-reports-test' : 'valuatum-pdf-reports'

const api = async (path) => {
  const res = await fetch(`${HOST}/api/public/${path}`, { headers: { Authorization: AUTH } })
  if (!res.ok) throw new Error(`langfuse ${path}: ${res.status} ${await res.text()}`)
  return res.json()
}

if (argv.includes('--list')) {
  const company = flag('company')
  const { data } = await api(`traces?limit=${flag('limit') ?? '20'}&name=resolve_render:osakeanalyysi`)
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

const pull = (key, out) => {
  try {
    execFileSync('aws', ['s3', 'cp', `s3://${BUCKET}/${key}`, out, '--quiet'], { stdio: 'pipe' })
    return true
  } catch (err) {
    console.warn(`! s3://${BUCKET}/${key}: ${String(err.message).split('\n')[0]}`)
    return false
  }
}
pull(`${meta.jobId}.pdf`, join(dir, 'report.pdf'))
const gotSnapshot = pull(`artifacts/${meta.jobId}.snapshot.json`, join(dir, 'snapshot.json'))

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
      source: isTest ? 'test' : 'prod',
      reportId: 'osakeanalyysi',
      company: meta.companyCode,
      lang: meta.lang,
      currency: meta.currency,
      country: meta.country,
      pipeline,
      models: [...new Set(obs.map((o) => o.model).filter(Boolean))].sort(),
      promptStore: `langfuse:${isTest ? 'staging' : 'production'}`,
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
