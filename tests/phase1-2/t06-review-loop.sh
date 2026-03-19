#!/bin/bash
# T06: Review loop — work → review → gate
set -euo pipefail

RESULTS_DIR="$(cd "$(dirname "$0")" && pwd)/results"
PROJECT_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
mkdir -p "$RESULTS_DIR"

echo "=== T06: Review loop ==="

rm -f "$PROJECT_ROOT/.sigbus/registry.json"

cd "$PROJECT_ROOT"
OUTPUT=$(deno run --allow-all src/cli.ts review "Say exactly: test-review-pass" --max 2 --name t06-rev 2>&1)
echo "$OUTPUT" > "$RESULTS_DIR/t06-review-output.txt"

# Check work agent ran
echo "$OUTPUT" | grep -q "t06-rev-work-1" || { echo "FAIL: work agent not found"; exit 1; }
echo "OK: work agent ran"

# Check review agent ran
echo "$OUTPUT" | grep -q "t06-rev-review-1" || { echo "FAIL: review agent not found"; exit 1; }
echo "OK: review agent ran"

# Check verdict
echo "$OUTPUT" | grep -q "Verdict:" || { echo "FAIL: no verdict"; exit 1; }
echo "OK: verdict rendered"

# Check cost reported
echo "$OUTPUT" | grep -q 'Cost: \$' || { echo "FAIL: no cost"; exit 1; }
echo "OK: cost reported"

# Cleanup
deno run --allow-all src/cli.ts cleanup --all > /dev/null 2>&1
rm -f bus-review-*.jsonl

echo ""
echo "All review loop tests passed (4/4)"
echo "PASS"
