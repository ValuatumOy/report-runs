# Report grading rubric — v1

Every registered run gets a `grade.json` next to its `meta.json`. Grading is
done by the Claude session that generated (or later audits) the run — no API
cost. The rubric is versioned so scores stay comparable across weeks: **never
edit v1 in place.** Change the criteria → bump to v2 and say so in the run's
`grade.json`, because v1 and v2 scores must not be averaged together.

## What to read before scoring

`runs/<runId>/snapshot.json` → `narrativeCache.data`. That holds the whole
report text: `coreAnalysis`, `valuePools[].deepDive`, `valuation`,
`scenarioValuation`, `catalysts`, `risks`, `sources`, `recommendation`.
The PDF adds layout, not content — read it only when judging readability or
checking that a table actually rendered.

## Criteria (1–5 each, one-line justification each, mandatory)

CEO priority: **analysis depth, coverage and logic first; the target price is a
function of the analysis, not a goal of its own.**

| # | Criterion | 1 | 3 | 5 |
|---|---|---|---|---|
| `depth` | Does each division get real analysis, not a summary? | Generic paragraphs that would fit any company | Divisions covered, some go one level below the obvious | Each division has mechanism-level reasoning: unit economics, capacity, pricing, what has to be true |
| `coverage` | Is everything that moves the value covered? | Major profit engine or optionality missing | All divisions present, some thin | Every profit engine and every optionality covered, plus what was deliberately excluded and why |
| `logic` | Does the argument hold together? | Claims contradict each other or the numbers | Mostly coherent, a few unsupported jumps | Every conclusion traceable to a stated premise; counter-arguments confronted |
| `evidence` | Is it grounded in facts, not vibes? | Numbers with no source, plausible-sounding invention | Key numbers sourced, some assertions bare | Concrete figures with periods and sources; estimates flagged as estimates |
| `valuation` | Is the bridge consistent with the text? | Bridge contradicts the analysis (e.g. optionality valued at zero while the text calls it the main driver) | Bridge follows the text, some components unexplained | Bridge, scenarios and market confrontation all use the same grammar, and the gap to the market price is explained |
| `readability` | Would a reader trust this document? | Empty tables, duplicate numbers, broken layout | Readable, some rough edges | Clean tables, no unexplained contradictions between numbers on different pages |

## grade.json shape

```json
{
  "rubricVersion": "v1",
  "grader": "claude-opus-5 (chat session)",
  "gradedAt": "2026-08-17T09:40:00Z",
  "scores": { "depth": 4, "coverage": 4, "logic": 4, "evidence": 3, "valuation": 3, "readability": 2 },
  "justifications": {
    "depth": "…one line per criterion, naming the concrete evidence in the report…"
  },
  "summary": "2–3 sentences: what this run did better/worse than its neighbours.",
  "issues": ["short, actionable defects worth fixing"]
}
```

## Procedure (for the grading agent)

1. Read `snapshot.json` → `narrativeCache.data` for the run.
2. Score all six criteria. Justify each with something specific from *this*
   report — a number, a sentence, a missing division. No generic praise.
3. Compare against the nearest neighbours in the registry (same company,
   other pipeline / earlier prompt versions). A score is only useful relative
   to them.
4. Write `runs/<runId>/grade.json`, then `npm run runs:build`.
