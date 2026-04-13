#!/bin/bash
# Shakedown B — tier-1 on `@snapshot/core`.
# Running on branch `shakedown-tier1` of the snapshot repo so Finding
# #7's unfixed snapshot-commits-to-HEAD behavior lands on a throwaway
# branch instead of master.
# Caps: $5 total, 15 minutes wall clock, 5 iterations max.

cd /Users/janzheng/Desktop/Projects/_deno/apps/snapshot

# Confirm we're on the throwaway branch before firing.
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$CURRENT_BRANCH" != "shakedown-tier1" ]; then
  echo "REFUSING: not on shakedown-tier1 (current: $CURRENT_BRANCH)."
  echo "Finding #7 means refine will pollute whatever branch you're on."
  exit 1
fi

EVENT_FILE=/tmp/expo-shakedown-tier1-snapshot-$(date +%s).jsonl
LOG_FILE=/tmp/expo-shakedown-tier1-snapshot-$(date +%s).log

exec expo refine . \
  --auto \
  --rubric-file /Users/janzheng/Desktop/Projects/_deno/apps/expo/shakedown/2026-04-13-tier1-snapshot/RUBRIC.md \
  --scope "src/**" \
  --max 5 \
  --run-timeout 900 \
  --total-budget 5 \
  --event-file $EVENT_FILE \
  > $LOG_FILE 2>&1

# After run, print the log path for artifact collection.
echo "Log:    $LOG_FILE"
echo "Events: $EVENT_FILE"
