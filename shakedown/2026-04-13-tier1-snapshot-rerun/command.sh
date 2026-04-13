#!/bin/bash
# Shakedown B tier-1 — RE-RUN with all fixes applied.
# Validation that Finding #7/#10 (branch HEAD not advancing) and
# Finding #8 (expo's runtime filtered from agent-touched) are
# actually fixed end-to-end.
# Same params as original tier-1 run. Fresh `shakedown-tier1-v2`
# branch, .refine/ state reset, no stale tags.

cd /Users/janzheng/Desktop/Projects/_deno/apps/snapshot

CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$CURRENT_BRANCH" != "shakedown-tier1-v2" ]; then
  echo "REFUSING: not on shakedown-tier1-v2 (current: $CURRENT_BRANCH)."
  exit 1
fi

EVENT_FILE=/tmp/expo-tier1-rerun-$(date +%s).jsonl
LOG_FILE=/tmp/expo-tier1-rerun-$(date +%s).log

exec expo refine . \
  --auto \
  --rubric-file /Users/janzheng/Desktop/Projects/_deno/apps/expo/shakedown/2026-04-13-tier1-snapshot/RUBRIC.md \
  --scope "src/**" \
  --max 5 \
  --run-timeout 900 \
  --total-budget 5 \
  --event-file $EVENT_FILE \
  > $LOG_FILE 2>&1
