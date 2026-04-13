#!/bin/bash
# Shakedown B tier-2 on smolvm (polyglot Rust+Deno, 15.9k TS LOC).
# Running on throwaway branch shakedown-tier2. TS scope only.
# Caps: $10 total, 30 min wall, 8 iter.

cd /Users/janzheng/Desktop/Projects/_deno/apps/smolvm

CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$CURRENT_BRANCH" != "shakedown-tier2" ]; then
  echo "REFUSING: not on shakedown-tier2 (current: $CURRENT_BRANCH)."
  exit 1
fi

EVENT_FILE=/tmp/expo-tier2-smolvm-$(date +%s).jsonl
LOG_FILE=/tmp/expo-tier2-smolvm-$(date +%s).log

exec expo refine . \
  --auto \
  --rubric-file /Users/janzheng/Desktop/Projects/_deno/apps/expo/shakedown/2026-04-13-tier2-smolvm/RUBRIC.md \
  --scope "cli/**" "sdk-ts/**" "tests/**" \
  --max 8 \
  --run-timeout 1800 \
  --total-budget 10 \
  --event-file $EVENT_FILE \
  > $LOG_FILE 2>&1
