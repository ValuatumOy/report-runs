import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The deterministic half of the nightly routine: find worker runs from the
 * last N hours that are not in the registry yet and import them, then report
 * which runs still need a grade.
 *
 *   node nightly.mjs [--hours 24] [--max 8]
 *
 * Grading is judgment, so it stays with the agent — nightly.sh feeds this
 * script's output to Claude. Exits 0 with "NOTHING NEW" when there is nothing
 * to do, so the wrapper can stop without spending anything.
 */

const ROOT = dirname(fileURLToPath(import.meta.url))
const RUNS = join(ROOT, 'runs')
const HOST = 'https://cloud.langfuse.com'

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : fallback
}
const HOURS = Number(arg('hours', 24))
const MAX = Number(arg('max', 8))

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

const dirs = () =>
  readdirSync(RUNS, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(RUNS, e.name, 'meta.json')))
    .map((e) => ({ dir: e.name, meta: JSON.parse(readFileSync(join(RUNS, e.name, 'meta.json'), 'utf8')) }))

const registered = dirs()
const known = new Set(registered.map((r) => r.meta.langfuseTraceId).filter(Boolean))
// One job can emit more than one trace. Keying only on the trace id imported the
// same S3 artifact twice under two run ids, so the job id gates as well — both
// against what is already on disk and within this batch, because meta.json for
// the first import is written after this filter has run.
const knownJobs = new Set(registered.map((r) => r.meta.jobId).filter(Boolean))
const since = new Date(Date.now() - HOURS * 3600 * 1000).toISOString()

const res = await fetch(
  `${HOST}/api/public/traces?limit=100&name=resolve_render:osakeanalyysi&fromTimestamp=${since}`,
  { headers: { Authorization: AUTH } },
)
if (!res.ok) throw new Error(`langfuse traces: ${res.status} ${await res.text()}`)
const seenJobs = new Set()
// Langfuse returns newest first, so the first trace kept for a job is its latest.
const traces = (await res.json()).data.filter(
  (t) =>
    t.metadata?.jobId &&
    !known.has(t.id) &&
    !knownJobs.has(t.metadata.jobId) &&
    !seenJobs.has(t.metadata.jobId) &&
    (seenJobs.add(t.metadata.jobId), true),
)

console.log(`window: last ${HOURS}h · ${traces.length} new worker run(s) found`)
for (const t of traces.slice(0, MAX)) {
  try {
    const out = execFileSync('node', [join(ROOT, 'import.mjs'), t.id], { cwd: ROOT, encoding: 'utf8', env })
    process.stdout.write(out)
  } catch (err) {
    // Exit 3 means the trace had no artifacts in either bucket; import.mjs has
    // already cleaned up after itself and said so. Anything else is a real
    // failure worth surfacing with its message.
    const out = String(err.stdout ?? '') + String(err.stderr ?? '')
    if (err.status === 3) process.stdout.write(out)
    else console.warn(`! import ${t.id} failed: ${out.trim().split('\n').pop() || err.message}`)
  }
}
if (traces.length > MAX) console.log(`! ${traces.length - MAX} run(s) left for the next pass (--max ${MAX})`)

// A run is worth grading when it has something to read.
const ungraded = dirs().filter(
  (r) =>
    !existsSync(join(RUNS, r.dir, 'grade.json')) &&
    (existsSync(join(RUNS, r.dir, 'snapshot.json')) || existsSync(join(RUNS, r.dir, 'report.pdf'))),
)

if (!ungraded.length) {
  console.log('NOTHING NEW')
  process.exit(0)
}
console.log(`\nUNGRADED (${ungraded.length}):`)
for (const r of ungraded.slice(0, MAX)) {
  const m = r.meta
  console.log(
    `${r.dir}  ${m.company} ${m.lang} · ${m.pipeline} · ${m.source} · ${m.rating ?? '–'} ${m.targetPrice ?? '–'} vs ${m.currentPrice ?? '–'}` +
      (existsSync(join(RUNS, r.dir, 'snapshot.json')) ? '' : '  [no snapshot — grade from report.pdf]'),
  )
}
