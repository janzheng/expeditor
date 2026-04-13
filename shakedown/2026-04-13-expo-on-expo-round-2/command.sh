#!/bin/bash
# Shakedown A — round 2 (post-fix re-run).
# Caps: $15 total, 1 hour wall clock, 10 iterations max.

cd /Users/janzheng/Desktop/Projects/_deno/apps/expo

EVENT_FILE=/tmp/expo-on-expo-round2-1776097600.jsonl
LOG_FILE=/tmp/expo-on-expo-round2-1776097600.log

exec expo refine . \
  --auto \
  --rubric-file .brief/SELF-REFINE-RUBRIC.md \
  --scope "src/**" "tests/**" \
  --max 10 \
  --run-timeout 3600 \
  --total-budget 15 \
  --force-stale-baseline \
  --event-file $EVENT_FILE \
  > $LOG_FILE 2>&1
