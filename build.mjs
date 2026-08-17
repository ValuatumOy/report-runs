import { readdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Builds index.html from every run folder's meta.json (+ optional grade.json).
 * No dependencies, no build step: `node build.mjs`.
 *
 * Prompt versions are shown as v1, v2, … in both worlds. Worker runs carry
 * Langfuse version numbers on their trace, and their chips link to the prompt
 * in Langfuse. Local runs read prompt files straight off disk, so there is no
 * server-side version to link — build.mjs assigns them sequential numbers per
 * prompt name in first-seen order and remembers the mapping in versions.json,
 * so the same file content keeps the same number forever.
 */

const ROOT = dirname(fileURLToPath(import.meta.url))
const RUNS = join(ROOT, 'runs')
const LANGFUSE_PROJECT = 'cmojqmvt900fcad07uc4g007x'
const LANGFUSE = `https://cloud.langfuse.com/project/${LANGFUSE_PROJECT}`
const CRITERIA = [
  ['depth', 'Depth'],
  ['coverage', 'Coverage'],
  ['logic', 'Logic'],
  ['evidence', 'Evidence'],
  ['valuation', 'Valuation'],
  ['readability', 'Readability'],
]

const runs = readdirSync(RUNS, { withFileTypes: true })
  .filter((e) => e.isDirectory() && !e.name.startsWith('_') && existsSync(join(RUNS, e.name, 'meta.json')))
  .map((e) => ({
    dir: e.name,
    meta: JSON.parse(readFileSync(join(RUNS, e.name, 'meta.json'), 'utf8')),
    grade: existsSync(join(RUNS, e.name, 'grade.json'))
      ? JSON.parse(readFileSync(join(RUNS, e.name, 'grade.json'), 'utf8'))
      : null,
    hasPdf: existsSync(join(RUNS, e.name, 'report.pdf')),
  }))
  .sort((a, b) => String(a.meta.createdAt).localeCompare(String(b.meta.createdAt)))

// --- local prompt-version ledger -------------------------------------------
const ledgerPath = join(ROOT, 'versions.json')
const ledger = existsSync(ledgerPath) ? JSON.parse(readFileSync(ledgerPath, 'utf8')) : {}
for (const { meta } of runs) {
  for (const p of meta.prompts ?? []) {
    if (!p.version?.startsWith('sha:')) continue
    const hash = p.version.slice(4)
    const seen = (ledger[p.name] ??= [])
    if (!seen.some((s) => s.hash === hash)) seen.push({ hash, firstSeen: meta.createdAt, version: seen.length + 1 })
  }
}
writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2) + '\n')
const localVersion = (name, hash) => ledger[name]?.find((s) => s.hash === hash)?.version

runs.reverse()

// --- helpers ---------------------------------------------------------------
const esc = (v) =>
  String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
const num = (v, d = 1) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : null)
const avg = (g) => {
  const vals = CRITERIA.map(([k]) => g?.scores?.[k]).filter((v) => typeof v === 'number')
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null
}
const when = (iso) => String(iso ?? '').slice(0, 16).replace('T', ' ')
const bandOf = (s) => (s == null ? 'na' : s <= 2 ? 'low' : s === 3 ? 'mid' : 'high')

const icon = {
  chevron: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 4l4 4-4 4"/></svg>',
  pdf: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9 1.5H4.5A1.5 1.5 0 0 0 3 3v10A1.5 1.5 0 0 0 4.5 14.5h7A1.5 1.5 0 0 0 13 13V5.5z"/><path d="M9 1.5V5.5H13"/></svg>',
  link: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9 3.5h3.5V7"/><path d="M12.5 3.5L7.75 8.25"/><path d="M11 9.5V12a.5.5 0 0 1-.5.5h-6A.5.5 0 0 1 4 12V6a.5.5 0 0 1 .5-.5H7"/></svg>',
}

const promptChip = (p) => {
  if (p.version?.startsWith('sha:')) {
    const hash = p.version.slice(4)
    const v = localVersion(p.name, hash)
    return `<span class="chip local" title="local file build — sha256 ${esc(hash)}">v${v ?? '?'}<span class="chip-note">local</span></span>`
  }
  const v = String(p.version ?? '').replace(/^v/, '')
  return `<a class="chip" href="${LANGFUSE}/prompts/${encodeURIComponent(p.name)}?version=${esc(v)}" target="_blank" rel="noreferrer" title="Open version ${esc(v)} in Langfuse">v${esc(v)}${icon.link}</a>`
}

// --- rows ------------------------------------------------------------------
const rows = runs
  .map(({ dir, meta, grade }, i) => {
    const a = avg(grade)
    const scores = CRITERIA.map(
      ([k]) =>
        `<td class="score"><span class="mark ${bandOf(grade?.scores?.[k])}">${grade?.scores?.[k] ?? '·'}</span></td>`,
    ).join('')
    const upside = num(meta.upsidePct, 0)
    const promptList = (meta.prompts ?? [])
      .map((p) => `<li><span class="pname">${esc(p.name)}</span>${promptChip(p)}</li>`)
      .join('')
    const gradeList = grade
      ? CRITERIA.map(
          ([k, label]) => `<li>
            <span class="mark ${bandOf(grade.scores?.[k])}">${grade.scores?.[k] ?? '·'}</span>
            <div><b>${label}</b><p>${esc(grade.justifications?.[k])}</p></div>
          </li>`,
        ).join('')
      : ''
    const facts = [
      ['Pipeline', esc(meta.pipeline)],
      ['Prompt store', esc(meta.promptStore)],
      meta.writerModel ? ['Writer model', esc(meta.writerModel)] : null,
      meta.models?.length ? ['Models', meta.models.map(esc).join(', ')] : null,
      meta.git?.sha ? ['Engine build', `${esc(meta.git.sha)}${meta.git.dirty ? ' (dirty)' : ''} · ${esc(meta.git.branch)}`] : null,
      meta.costUsd != null ? ['Cost', `$${num(meta.costUsd, 2)} · ${meta.llmCalls ?? '?'} calls`] : null,
      meta.durationSec != null ? ['Duration', `${Math.round(meta.durationSec / 60)} min${meta.backfilled ? ' (estimated)' : ''}`] : null,
      meta.langfuseTraceId
        ? ['Trace', `<a href="${LANGFUSE}/traces/${esc(meta.langfuseTraceId)}" target="_blank" rel="noreferrer">Langfuse${icon.link}</a>`]
        : null,
    ]
      .filter(Boolean)
      .map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`)
      .join('')

    return `<tr class="run" data-pipeline="${esc(meta.pipeline)}" data-source="${esc(meta.source)}" data-company="${esc(meta.company)}" data-graded="${grade ? 'yes' : 'no'}" data-avg="${a ?? -1}" data-when="${esc(meta.createdAt)}" data-target="${meta.targetPrice ?? -1}">
    <td class="cell-when">
      <button class="disclose" aria-expanded="false" aria-controls="d${i}">${icon.chevron}<span>${when(meta.createdAt)}</span></button>
    </td>
    <td><span class="company">${esc(meta.company)}</span> <span class="dim">${esc(meta.lang)}</span></td>
    <td><span class="tag ${meta.pipeline === 'single-writer' ? 'sw' : 'ms'}">${esc(meta.pipeline)}</span></td>
    <td><span class="dim">${esc(meta.source)}</span></td>
    <td>${meta.rating ? `<span class="rating">${esc(meta.rating)}</span>` : '<span class="dim">—</span>'}</td>
    <td class="n">${num(meta.targetPrice, 1) ?? '<span class="dim">—</span>'}</td>
    <td class="n">${num(meta.currentPrice, 1) ?? '<span class="dim">—</span>'}</td>
    <td class="n ${upside != null && Number(upside) < 0 ? 'neg' : ''}">${upside != null ? upside + '%' : '<span class="dim">—</span>'}</td>
    <td class="n">${meta.costUsd != null ? '$' + num(meta.costUsd, 2) : '<span class="dim">—</span>'}</td>
    ${scores}
    <td class="n avg">${num(a, 1) ?? '<span class="dim">—</span>'}</td>
  </tr>
  <tr class="detail" id="d${i}" hidden>
    <td colspan="16">
      <div class="panel">
        <section>
          <h3>Run</h3>
          <dl class="facts">${facts}</dl>
          ${meta.note ? `<p class="note">${esc(meta.note)}</p>` : ''}
          ${runs[i].hasPdf ? `<a class="btn" href="runs/${esc(dir)}/report.pdf">${icon.pdf}Open PDF</a>` : '<p class="note">PDF not archived for this run.</p>'}
        </section>
        <section>
          <h3>Prompt versions</h3>
          <ul class="prompts">${promptList || '<li class="dim">none recorded</li>'}</ul>
        </section>
        <section class="grade">
          <h3>Grade ${grade ? `<span class="dim">rubric ${esc(grade.rubricVersion)} · ${esc(grade.grader)}</span>` : ''}</h3>
          ${
            grade
              ? `<p class="summary">${esc(grade.summary)}</p>
                 <ul class="criteria">${gradeList}</ul>
                 ${grade.issues?.length ? `<h4>Issues</h4><ul class="issues">${grade.issues.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>` : ''}
                 ${grade.basis ? `<p class="note">${esc(grade.basis)}</p>` : ''}`
              : '<p class="note">Not graded yet. Score it against RUBRIC.md, write grade.json in the run folder, rerun <code>node build.mjs</code>.</p>'
          }
        </section>
      </div>
    </td>
  </tr>`
  })
  .join('\n')

// --- summary ---------------------------------------------------------------
const graded = runs.filter((r) => r.grade)
const best = graded.reduce((b, r) => (avg(r.grade) > (b ? avg(b.grade) : -1) ? r : b), null)
const byPipeline = ['single-writer', 'multi-stage'].map((p) => {
  const g = graded.filter((r) => r.meta.pipeline === p)
  return { p, n: g.length, avg: g.length ? g.reduce((s, r) => s + avg(r.grade), 0) / g.length : null }
})
const companies = [...new Set(runs.map((r) => r.meta.company))].sort()

const html = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Report generations</title>
<style>
:root{
  color-scheme: light dark;
  --bg:#f6f6f4; --panel:#fff; --panel-2:#faf9f7; --line:#e3e1dc; --line-strong:#d2cfc8;
  --ink:#1c1b19; --ink-2:#57534c; --ink-3:#8b867c;
  --accent:#3f5bd9; --accent-soft:#eaeeff;
  --low:#a33a2c; --low-bg:#fbe9e5; --mid:#7a6a2f; --mid-bg:#f7f0d9; --high:#2c6b45; --high-bg:#e4f2e8;
  --sw:#2f4fbd; --sw-bg:#e8edfd; --ms:#8a5a1f; --ms-bg:#f7eddc;
  --shadow:0 1px 2px rgba(28,27,25,.05), 0 8px 24px -12px rgba(28,27,25,.18);
  --radius:10px;
}
@media (prefers-color-scheme: dark){
  :root{
    --bg:#131311; --panel:#1b1b19; --panel-2:#201f1d; --line:#2c2b28; --line-strong:#3a3935;
    --ink:#f0eee9; --ink-2:#b3afa6; --ink-3:#807b72;
    --accent:#93a6ff; --accent-soft:#232744;
    --low:#f0938a; --low-bg:#3a221f; --mid:#dcc178; --mid-bg:#332c1a; --high:#8ed4a6; --high-bg:#1d3227;
    --sw:#9db0ff; --sw-bg:#212845; --ms:#e0b070; --ms-bg:#37291a;
    --shadow:0 1px 2px rgba(0,0,0,.4), 0 12px 32px -16px rgba(0,0,0,.7);
  }
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{
  margin:0; background:var(--bg); color:var(--ink);
  font:15px/1.5 ui-sans-serif,-apple-system,"Segoe UI",Roboto,sans-serif;
  font-variant-numeric:tabular-nums; padding:40px 28px 96px;
}
.wrap{max-width:1400px;margin:0 auto}
header{margin-bottom:28px}
h1{font-size:1.5rem;font-weight:640;letter-spacing:-.02em;margin:0 0 6px}
.lede{color:var(--ink-2);margin:0;max-width:70ch}
.lede a{color:var(--accent)}

.stats{display:flex;flex-wrap:wrap;gap:10px;margin:22px 0 18px}
.stat{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:12px 16px;min-width:150px;box-shadow:var(--shadow)}
.stat dt{font-size:.72rem;letter-spacing:.06em;text-transform:uppercase;color:var(--ink-3);margin:0 0 4px}
.stat dd{margin:0;font-size:1.35rem;font-weight:620;letter-spacing:-.02em}
.stat dd small{font-size:.8rem;font-weight:450;color:var(--ink-2);margin-left:6px}

.toolbar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:14px}
.toolbar .group{display:flex;gap:4px;background:var(--panel);border:1px solid var(--line);border-radius:999px;padding:3px}
.toolbar button{
  appearance:none;border:0;background:transparent;color:var(--ink-2);
  font:inherit;font-size:.85rem;padding:5px 12px;border-radius:999px;cursor:pointer;
  transition:background .15s ease,color .15s ease;
}
.toolbar button:hover{background:var(--panel-2);color:var(--ink)}
.toolbar button[aria-pressed=true]{background:var(--accent-soft);color:var(--accent)}
.toolbar button:focus-visible,.disclose:focus-visible,a:focus-visible,th button:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:6px}
.count{margin-left:auto;color:var(--ink-3);font-size:.85rem}

.table-wrap{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);box-shadow:var(--shadow);overflow-x:auto}
table{border-collapse:collapse;width:100%;font-size:.88rem}
thead th{
  position:sticky;top:0;z-index:2;background:var(--panel);
  text-align:left;font-weight:560;font-size:.7rem;letter-spacing:.07em;text-transform:uppercase;color:var(--ink-3);
  padding:11px 10px;border-bottom:1px solid var(--line-strong);white-space:nowrap;
}
thead th.score,thead th.n{text-align:right}
thead th button{appearance:none;border:0;background:none;font:inherit;color:inherit;cursor:pointer;padding:0;letter-spacing:inherit;text-transform:inherit}
thead th button:hover{color:var(--ink)}
thead th[aria-sort] button::after{content:"↓";margin-left:4px;opacity:.9}
thead th[aria-sort=ascending] button::after{content:"↑"}
tbody td{padding:9px 10px;border-bottom:1px solid var(--line);white-space:nowrap;vertical-align:middle}
tr.run:hover td{background:var(--panel-2)}
tr.run.open td{background:var(--panel-2)}
tr.run:last-child td,tr.detail:last-child td{border-bottom:0}
td.n{text-align:right}
td.n.neg{color:var(--low)}
td.avg{font-weight:640;font-size:.95rem;border-left:1px solid var(--line)}
td.score{text-align:right;padding-left:4px;padding-right:4px}
.dim{color:var(--ink-3)}
.company{font-weight:580}
.rating{font-weight:600;letter-spacing:.02em}

.cell-when{padding-left:6px}
.disclose{display:flex;align-items:center;gap:7px;appearance:none;border:0;background:none;color:var(--ink);font:inherit;cursor:pointer;padding:2px 4px}
.disclose svg{width:13px;height:13px;fill:none;stroke:var(--ink-3);stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round;transition:transform .18s cubic-bezier(.2,.7,.3,1)}
.disclose[aria-expanded=true] svg{transform:rotate(90deg);stroke:var(--accent)}

.tag{display:inline-block;padding:2px 9px;border-radius:999px;font-size:.75rem;font-weight:550;letter-spacing:.01em}
.tag.sw{background:var(--sw-bg);color:var(--sw)}
.tag.ms{background:var(--ms-bg);color:var(--ms)}
.mark{display:inline-flex;align-items:center;justify-content:center;min-width:24px;height:24px;padding:0 6px;border-radius:7px;font-size:.82rem;font-weight:580}
.mark.low{background:var(--low-bg);color:var(--low)}
.mark.mid{background:var(--mid-bg);color:var(--mid)}
.mark.high{background:var(--high-bg);color:var(--high)}
.mark.na{background:transparent;color:var(--ink-3)}

tr.detail td{padding:0;background:var(--panel-2);white-space:normal}
.panel{display:grid;grid-template-columns:minmax(230px,1fr) minmax(230px,1fr) minmax(320px,1.6fr);gap:28px;padding:22px 20px 26px;border-bottom:1px solid var(--line);animation:reveal .18s cubic-bezier(.2,.7,.3,1)}
@keyframes reveal{from{opacity:0;transform:translateY(-3px)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion: reduce){.panel{animation:none}.disclose svg{transition:none}}
.panel h3{margin:0 0 12px;font-size:.72rem;letter-spacing:.07em;text-transform:uppercase;color:var(--ink-3);font-weight:560}
.panel h3 .dim{text-transform:none;letter-spacing:0;font-size:.78rem;margin-left:6px}
.panel h4{margin:16px 0 6px;font-size:.78rem;color:var(--ink-2);font-weight:580}

.facts{margin:0;display:grid;gap:7px}
.facts div{display:grid;grid-template-columns:96px 1fr;gap:10px;align-items:baseline}
.facts dt{color:var(--ink-3);font-size:.78rem}
.facts dd{margin:0;font-size:.85rem;overflow-wrap:anywhere}
.facts a{color:var(--accent);text-decoration:none;display:inline-flex;align-items:center;gap:3px;white-space:nowrap}

.prompts{list-style:none;margin:0;padding:0;display:grid;gap:6px}
.prompts li{display:flex;align-items:center;justify-content:space-between;gap:12px;font-size:.83rem;padding-bottom:6px;border-bottom:1px dashed var(--line)}
.prompts li:last-child{border-bottom:0}
.pname{color:var(--ink-2);overflow-wrap:anywhere}
.chip{display:inline-flex;align-items:center;gap:4px;background:var(--accent-soft);color:var(--accent);border-radius:6px;padding:2px 7px;font-size:.78rem;font-weight:580;text-decoration:none;white-space:nowrap}
.chip.local{background:transparent;border:1px solid var(--line-strong);color:var(--ink-2)}
.chip-note{color:var(--ink-3);font-weight:450;font-size:.7rem}
.chip svg{width:11px;height:11px;fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}

.summary{margin:0 0 14px;color:var(--ink);font-size:.9rem;max-width:72ch}
.criteria{list-style:none;margin:0;padding:0;display:grid;gap:10px}
.criteria li{display:grid;grid-template-columns:26px 1fr;gap:10px;align-items:start}
.criteria b{font-size:.82rem;font-weight:600}
.criteria p{margin:2px 0 0;color:var(--ink-2);font-size:.85rem;max-width:74ch}
.issues{margin:0;padding-left:18px;color:var(--ink-2);font-size:.85rem;display:grid;gap:3px}
.note{color:var(--ink-3);font-size:.82rem;margin:12px 0 0;max-width:72ch}
.note code{font-size:.95em}

.btn{display:inline-flex;align-items:center;gap:7px;margin-top:14px;padding:7px 13px;border:1px solid var(--line-strong);border-radius:8px;color:var(--ink);text-decoration:none;font-size:.84rem;font-weight:520;background:var(--panel);transition:border-color .15s ease,background .15s ease}
.btn:hover{border-color:var(--accent);background:var(--accent-soft);color:var(--accent)}
.btn svg{width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}

.empty{padding:56px 20px;text-align:center;color:var(--ink-3)}
footer{margin-top:20px;color:var(--ink-3);font-size:.8rem}
/* The detail row lives inside the table's horizontal scroll box, so on narrow
   screens pin it to the scrollport instead of letting it inherit the (much
   wider) table width — otherwise the version chips sit off-screen. */
@media (max-width:900px){
  body{padding:24px 14px 64px}
  .panel{grid-template-columns:1fr;gap:22px;position:sticky;left:0;width:calc(100vw - 30px);padding:20px 16px 24px}
}
@media (max-width:560px){.facts div{grid-template-columns:1fr;gap:1px}.facts dt{font-size:.74rem}.stat{flex:1 1 140px;min-width:0}}
</style>
<body>
<div class="wrap">
<header>
  <h1>Report generations</h1>
  <p class="lede">Every osakeanalyysi run we can trace: which pipeline and prompt versions produced it, and how the analysis scored against <a href="RUBRIC.md">RUBRIC.md</a>. Open a row to see the prompt versions behind it.</p>
  <dl class="stats">
    <div class="stat"><dt>Runs</dt><dd>${runs.length}<small>${graded.length} graded</small></dd></div>
    ${byPipeline
      .map(
        (b) =>
          `<div class="stat"><dt>${b.p}</dt><dd>${b.avg != null ? b.avg.toFixed(1) : '—'}<small>avg · ${b.n} graded</small></dd></div>`,
      )
      .join('')}
    <div class="stat"><dt>Best run</dt><dd>${best ? avg(best.grade).toFixed(1) : '—'}<small>${best ? esc(when(best.meta.createdAt)) : ''}</small></dd></div>
  </dl>
</header>

<div class="toolbar">
  <div class="group" role="group" aria-label="Filter by pipeline">
    <button data-filter="pipeline" data-value="" aria-pressed="true">All pipelines</button>
    <button data-filter="pipeline" data-value="single-writer" aria-pressed="false">single-writer</button>
    <button data-filter="pipeline" data-value="multi-stage" aria-pressed="false">multi-stage</button>
  </div>
  <div class="group" role="group" aria-label="Filter by source">
    <button data-filter="source" data-value="" aria-pressed="true">All sources</button>
    <button data-filter="source" data-value="local" aria-pressed="false">local</button>
    <button data-filter="source" data-value="test" aria-pressed="false">test</button>
    <button data-filter="source" data-value="prod" aria-pressed="false">prod</button>
  </div>
  ${
    companies.length > 1
      ? `<div class="group" role="group" aria-label="Filter by company">
          <button data-filter="company" data-value="" aria-pressed="true">All companies</button>
          ${companies.map((c) => `<button data-filter="company" data-value="${esc(c)}" aria-pressed="false">${esc(c)}</button>`).join('')}
        </div>`
      : ''
  }
  <div class="group" role="group" aria-label="Filter by grade state">
    <button data-filter="graded" data-value="" aria-pressed="true">All</button>
    <button data-filter="graded" data-value="yes" aria-pressed="false">Graded</button>
    <button data-filter="graded" data-value="no" aria-pressed="false">Ungraded</button>
  </div>
  <span class="count" id="count"></span>
</div>

<div class="table-wrap">
<table>
  <thead>
    <tr>
      <th aria-sort="descending"><button data-sort="when">When</button></th>
      <th>Company</th><th>Pipeline</th><th>Src</th><th>Rating</th>
      <th class="n"><button data-sort="target">Target</button></th>
      <th class="n">Spot</th><th class="n">Upside</th><th class="n">Cost</th>
      ${CRITERIA.map(([k, label]) => `<th class="score" title="${label}">${label.slice(0, 4)}</th>`).join('')}
      <th class="n"><button data-sort="avg">Avg</button></th>
    </tr>
  </thead>
  <tbody id="body">
${rows}
  </tbody>
</table>
<p class="empty" id="empty" hidden>No runs match these filters.</p>
</div>

<footer>Built ${new Date().toISOString().slice(0, 16).replace('T', ' ')} · <code>node build.mjs</code></footer>
</div>

<script>
const rowsOf = () => [...document.querySelectorAll('tr.run')]
const filters = { pipeline: '', source: '', company: '', graded: '' }

function apply(){
  let shown = 0
  for (const row of rowsOf()){
    const ok = Object.entries(filters).every(([k, v]) => !v || row.dataset[k] === v)
    row.hidden = !ok
    const detail = document.getElementById(row.querySelector('.disclose').getAttribute('aria-controls'))
    if (!ok){ detail.hidden = true; row.classList.remove('open'); row.querySelector('.disclose').setAttribute('aria-expanded','false') }
    if (ok) shown++
  }
  document.getElementById('count').textContent = shown + ' of ' + rowsOf().length + ' runs'
  document.getElementById('empty').hidden = shown > 0
}

document.querySelectorAll('.toolbar button').forEach((b) => b.addEventListener('click', () => {
  const { filter, value } = b.dataset
  filters[filter] = value
  b.parentElement.querySelectorAll('button').forEach((o) => o.setAttribute('aria-pressed', String(o === b)))
  apply()
}))

document.querySelectorAll('.disclose').forEach((b) => b.addEventListener('click', () => {
  const detail = document.getElementById(b.getAttribute('aria-controls'))
  const open = b.getAttribute('aria-expanded') === 'true'
  b.setAttribute('aria-expanded', String(!open))
  b.closest('tr').classList.toggle('open', !open)
  detail.hidden = open
}))

document.querySelectorAll('th button[data-sort]').forEach((b) => b.addEventListener('click', () => {
  const key = b.dataset.sort
  const th = b.closest('th')
  const asc = th.getAttribute('aria-sort') === 'descending' ? true : false
  document.querySelectorAll('th').forEach((o) => o.removeAttribute('aria-sort'))
  th.setAttribute('aria-sort', asc ? 'ascending' : 'descending')
  const body = document.getElementById('body')
  const pairs = rowsOf().map((r) => [r, document.getElementById(r.querySelector('.disclose').getAttribute('aria-controls'))])
  pairs.sort(([a],[c]) => {
    const av = key === 'when' ? a.dataset.when : Number(a.dataset[key])
    const cv = key === 'when' ? c.dataset.when : Number(c.dataset[key])
    return (av < cv ? -1 : av > cv ? 1 : 0) * (asc ? 1 : -1)
  })
  for (const [r, d] of pairs){ body.append(r); body.append(d) }
}))

apply()
</script>
</body>
</html>
`

writeFileSync(join(ROOT, 'index.html'), html)
console.log(`→ index.html  (${runs.length} runs, ${graded.length} graded)`)
