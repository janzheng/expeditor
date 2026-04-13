#!/bin/bash
# Shakedown A round 3 — full-validation re-run after all fixes.
# Fresh .refine/ state. All 10 fixes from today in place.
# Same rubric + scope + caps as rounds 1-2 for apples-to-apples.
# Caps: $15 total, 1hr wall clock, 10 iterations max.

cd /Users/janzheng/Desktop/Projects/_deno/apps/expo

EVENT_FILE=/tmp/expo-round3-$(date +%s).jsonl
LOG_FILE=/tmp/expo-round3-$(date +%s).log

exec expo refine . \
  --auto \
  --rubric-file .brief/SELF-REFINE-RUBRIC.md \
  --scope "src/**" "tests/**" \
  --max 10 \
  --run-timeout 3600 \
  --total-budget 15 \
  --event-file $EVENT_FILE \
  > $LOG_FILE 2>&1
