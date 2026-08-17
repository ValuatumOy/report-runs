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

const known = new Set(dirs().map((r) => r.meta.langfuseTraceId).filter(Boolean))
const since = new Date(Date.now() - HOURS * 3600 * 1000).toISOString()

const res = await fetch(
  `${HOST}/api/public/traces?limit=100&name=resolve_render:osakeanalyysi&fromTimestamp=${since}`,
  { headers: { Authorization: AUTH } },
)
if (!res.ok) throw new Error(`langfuse traces: ${res.status} ${await res.text()}`)
const traces = (await res.json()).data.filter((t) => t.metadata?.jobId && !known.has(t.id))

console.log(`window: last ${HOURS}h · ${traces.length} new worker run(s) found`)
for (const t of traces.slice(0, MAX)) {
  try {
    const out = execFileSync('node', [join(ROOT, 'import.mjs'), t.id], { cwd: ROOT, encoding: 'utf8', env })
    process.stdout.write(out)
  } catch (err) {
    console.warn(`! import ${t.id} failed: ${String(err.message).split('\n')[0]}`)
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
