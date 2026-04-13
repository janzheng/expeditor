#!/bin/bash
# Shakedown A — expo-on-expo, unattended.
# Fired from /Users/janzheng/Desktop/Projects/_deno/apps/expo via run_in_background Bash tool.
# Caps: $15 total, 1 hour wall clock, 10 iterations max.
# Scope: src/** tests/** — nothing else may be touched.

cd /Users/janzheng/Desktop/Projects/_deno/apps/expo

exec expo refine . \
  --auto \
  --rubric-file .brief/SELF-REFINE-RUBRIC.md \
  --scope "src/**" "tests/**" \
  --max 10 \
  --run-timeout 3600 \
  --total-budget 15 \
  --event-file /tmp/expo-on-expo-1776092941.jsonl \
  > /tmp/expo-on-expo-1776092941.log 2>&1
