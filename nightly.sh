#!/bin/zsh
# Local half of the nightly routine: import the worker runs and push
# everything this machine has.
#
# The S3 fetch happens here rather than in the cloud because the only AWS key
# on hand belongs to a user who can read the whole account and delete buckets;
# that key does not belong in a sandbox. This machine already has it as a
# profile, so it does the import, and the cloud routine (report-runs nightly
# grader) grades whatever arrives without a grade.json. Runs generated locally
# by `npm run preview` are already registered here by the engine.
# Pushing is also the deploy — Vercel builds the site from the repository.
#
# Installed as launchd job com.valuatum.report-runs-nightly (03:17), or run by
# hand: ~/Valuatum/report-runs/nightly.sh

set -u
export PATH="$HOME/.nvm/versions/node/v24.14.1/bin:/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin"
export AWS_PROFILE=valuatum-pdf
export AWS_DEFAULT_REGION=eu-west-1

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

# A 48-hour window covers a night the laptop spent asleep.
node nightly.mjs --hours 48 --max 8

if [ -z "$(git status --porcelain runs)" ]; then
  echo "=== nothing new to push, done"
  exit 0
fi

git add runs
COUNT=$(git diff --cached --name-only | awk -F/ '{print $2}' | sort -u | wc -l | tr -d ' ')
git commit -q -m "Add $COUNT run(s) from this machine

Local runs registered by the engine's preview script, plus any worker runs
imported from Langfuse and S3. The cloud routine grades whatever arrives here
without a grade.json."
git push -q origin main && echo "=== pushed $COUNT run(s)"
echo "=== $(date '+%H:%M:%S') done"
