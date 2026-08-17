#!/bin/zsh
# Local half of the nightly routine: push whatever this machine generated.
#
# Runs from this laptop register themselves here when `npm run preview` renders
# a report (see the engine's scripts/runsRegister.ts), and the cloud routine
# only ever sees what is in git. This job commits and pushes those runs; the
# cloud routine (report-runs nightly grader) then imports the worker runs,
# grades everything ungraded, and pushes back. Pushing is also the deploy —
# Vercel builds the site from the repository.
#
# Installed as launchd job com.valuatum.report-runs-nightly (03:17), or run by
# hand: ~/Valuatum/report-runs/nightly.sh

set -u
export PATH="$HOME/.nvm/versions/node/v24.14.1/bin:/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin"

ROOT="$HOME/Valuatum/report-runs"
LOG_DIR="$ROOT/logs"
mkdir -p "$LOG_DIR"
cd "$ROOT" || exit 1

exec >> "$LOG_DIR/nightly-$(date +%Y-%m-%d).log" 2>&1
echo "=== $(date '+%Y-%m-%d %H:%M:%S') local push start"

git fetch --quiet origin main && git rebase --quiet origin/main || {
  echo "! rebase onto origin/main failed — leaving the tree alone"
  exit 1
}

if [ -z "$(git status --porcelain runs)" ]; then
  echo "=== no local runs to push, done"
  exit 0
fi

git add runs
COUNT=$(git diff --cached --name-only | awk -F/ '{print $2}' | sort -u | wc -l | tr -d ' ')
git commit -q -m "Add $COUNT local run(s) generated on this machine

Registered by the engine's preview script; the cloud routine grades whatever
arrives here without a grade.json."
git push -q origin main && echo "=== pushed $COUNT run(s)"
echo "=== $(date '+%H:%M:%S') done"
