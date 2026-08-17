#!/bin/zsh
# Nightly routine: import the last day's worker runs, grade whatever is
# ungraded, rebuild and redeploy the dashboard.
#
# The deterministic half is nightly.mjs. Grading is judgment, so this script
# hands the ungraded list to Claude in headless mode. Run by launchd
# (~/Library/LaunchAgents/com.valuatum.report-runs-nightly.plist) — or by hand:
#   ~/Valuatum/report-runs/nightly.sh

set -u
export PATH="$HOME/.nvm/versions/node/v24.14.1/bin:/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin"
export AWS_PROFILE=valuatum-pdf

ROOT="$HOME/Valuatum/report-runs"
LOG_DIR="$ROOT/logs"
LOG="$LOG_DIR/nightly-$(date +%Y-%m-%d).log"
mkdir -p "$LOG_DIR"
cd "$ROOT" || exit 1

exec >> "$LOG" 2>&1
echo "=== $(date '+%Y-%m-%d %H:%M:%S') nightly start"

FOUND=$(node nightly.mjs --hours 24 --max 8)
echo "$FOUND"

if echo "$FOUND" | grep -q "NOTHING NEW"; then
  echo "=== nothing to grade, done"
  exit 0
fi

claude -p "You are the nightly grader for the report-runs registry in $ROOT.

nightly.mjs has already imported the new worker runs. Its output:

$FOUND

For every run listed under UNGRADED:
 1. Read runs/<runId>/snapshot.json and grade from narrativeCache.data. If the
    line says [no snapshot — grade from report.pdf], run
    'pdftotext -layout runs/<runId>/report.pdf -' and grade from that instead.
 2. Score the six criteria in RUBRIC.md v1 (1-5 each) and write
    runs/<runId>/grade.json exactly in the shape RUBRIC.md documents, including
    rubricVersion 'v1', grader, gradedAt, basis, one justification per
    criterion naming concrete evidence from that report, a summary comparing it
    to the nearest runs already in the registry, and an issues array.
 3. Keep the prose neutral and publishable — this dashboard is shared outside
    the team. No names, no internal opinions, no references to which report the
    sales site uses.

Then run 'node build.mjs', deploy with
'vercel --prod --yes --scope valuatum-dk', and commit with git (author
laurihynonen23 <lauri.hynonen@gmail.com>) describing which runs were added and
graded. Report the deployed URL and each run's average score as your final
message." \
  --allowed-tools "Read Write Edit Bash(node:*) Bash(pdftotext:*) Bash(vercel:*) Bash(git:*) Bash(ls:*) Bash(cat:*) Bash(grep:*)"

echo "=== $(date '+%H:%M:%S') nightly done"
