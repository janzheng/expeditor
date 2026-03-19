#!/bin/bash
# T08: Ralph — sequential task progression with gate
set -euo pipefail

RESULTS_DIR="$(cd "$(dirname "$0")" && pwd)/results"
PROJECT_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
mkdir -p "$RESULTS_DIR"

echo "=== T08: Ralph ==="

rm -f "$PROJECT_ROOT/.sigbus/registry.json"

cd "$PROJECT_ROOT"
# 2 tasks max — work agent counts, gate says DONE after 2
OUTPUT=$(deno run --allow-all src/cli.ts ralph \
  "Pick a random number between 1-100 and say it." \
  "If this is the 2nd task or later, say DONE. Otherwise say NEXT." \
  --max 3 --name t08-ralph 2>&1)
echo "$OUTPUT" > "$RESULTS_DIR/t08-ralph-output.txt"

# Work agent should run
echo "$OUTPUT" | grep -q "t08-ralph-task-1" || { echo "FAIL: task-1 not found"; exit 1; }
echo "OK: task-1 ran"

# Gate should run
echo "$OUTPUT" | grep -q "t08-ralph-gate-1" || { echo "FAIL: gate-1 not found"; exit 1; }
echo "OK: gate-1 ran"

# Result should show
echo "$OUTPUT" | grep -q "Verdict:" || { echo "FAIL: no verdict"; exit 1; }
echo "OK: verdict rendered"

echo "$OUTPUT" | grep -q "Tasks completed:" || { echo "FAIL: no task count"; exit 1; }
echo "OK: task count reported"

echo "$OUTPUT" | grep -q 'Cost: \$' || { echo "FAIL: no cost"; exit 1; }
echo "OK: cost reported"

# Cleanup
deno run --allow-all src/cli.ts cleanup --all > /dev/null 2>&1
rm -f bus-ralph-*.jsonl

echo ""
echo "All ralph tests passed (5/5)"
echo "PASS"
