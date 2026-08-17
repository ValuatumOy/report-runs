# report-runs

Every osakeanalyysi generation we can trace, with the prompt versions that
produced it and an AI grade of the analysis. This is how we get back to a good
report after a change makes the output worse.

```bash
node build.mjs     # rebuild index.html, then open it
open index.html
```

## What a run looks like

```
runs/2026-08-17T00-07-00Z__TSLA__single-writer/
  meta.json      what produced it: pipeline, models, prompt versions, cost, rating/target
  grade.json     the rubric scores (written by the reviewing Claude session)
  report.pdf     the artifact
  snapshot.json  the data + narrative the PDF was rendered from — grade from this
  run.log        local runs only
```

Heavy artifacts (`report.pdf`, `snapshot.json`) stay out of git; `meta.json`,
`grade.json` and `versions.json` are the record and are tracked.

## How runs get here

**Local runs (this chat)** register themselves. A paid `npm run preview` in
`../pdf-report-engine` writes its run folder here automatically — set
`REPORT_RUNS_DIR` to point somewhere else. Snapshot-cache replays and stub
renders register nothing, because nothing was generated.

**Worker runs (test stack, production)** are imported after the fact from
their Langfuse trace plus the S3 artifacts:

```bash
AWS_PROFILE=valuatum-pdf node import.mjs --list --company TSLA
AWS_PROFILE=valuatum-pdf node import.mjs <traceId> [--test] [--note "..."]
```

`--test` reads the test stack's bucket and labels the run `test`. Langfuse
credentials are read from `../pdf-report-engine/.env` when the environment
does not carry them.

S3 objects are fetched with a signed request from `s3.mjs`, so no AWS CLI is
needed. Credentials come from `REPORT_RUNS_AWS_ACCESS_KEY_ID` /
`REPORT_RUNS_AWS_SECRET_ACCESS_KEY`, then `AWS_ACCESS_KEY_ID` /
`AWS_SECRET_ACCESS_KEY`, then the `AWS_PROFILE` entry in `~/.aws/credentials`.
The `REPORT_RUNS_` names exist because some sandboxes fill the plain `AWS_`
variables with a `proxy-injected` placeholder that would otherwise win.

## Nightly

Two halves. The cloud routine (`report-runs nightly grader`, 03:17 Helsinki)
imports the last day's worker runs, grades whatever has no `grade.json`, and
pushes — and the push is the deploy, because Vercel builds this repository.
This machine runs `nightly.sh` from launchd, which only commits and pushes the
runs generated locally; the cloud agent cannot see them until they are in git.

## Prompt versions

Both worlds show up as `v1`, `v2`, … but they mean different things:

- **Worker runs** carry Langfuse version numbers on the trace. Those are the
  real, server-side versions, and each chip links to that version in Langfuse.
- **Local runs** read prompt files off disk, where no version exists. `build.mjs`
  hashes the prompt body and assigns the next number per prompt name in
  first-seen order, remembering it in `versions.json` — so the same file
  content always keeps the same number. These chips are marked `local`.

## Grading

The grader is the Claude session that generated (or later audits) the run — no
API cost. Read `runs/<runId>/snapshot.json` → `narrativeCache.data`, score the
six criteria in [RUBRIC.md](RUBRIC.md), write `runs/<runId>/grade.json`, rerun
`node build.mjs`.

The rubric is versioned and never edited in place: change the criteria, bump to
v2, and don't average v1 and v2 scores together.
