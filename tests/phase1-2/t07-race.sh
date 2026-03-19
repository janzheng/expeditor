#!/bin/bash
# T07: Race — parallel branches + judge picks winner
set -euo pipefail

RESULTS_DIR="$(cd "$(dirname "$0")" && pwd)/results"
PROJECT_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
mkdir -p "$RESULTS_DIR"

echo "=== T07: Race ==="

rm -f "$PROJECT_ROOT/.sigbus/registry.json"

cd "$PROJECT_ROOT"
OUTPUT=$(deno run --allow-all src/cli.ts race "Name 3 fruits" vs "Name 3 vegetables" --criteria "which list is more nutritious" --name t07-race 2>&1)
echo "$OUTPUT" > "$RESULTS_DIR/t07-race-output.txt"

# Both branches should run
echo "$OUTPUT" | grep -q "t07-race-branch-1" || { echo "FAIL: branch-1 not found"; exit 1; }
echo "$OUTPUT" | grep -q "t07-race-branch-2" || { echo "FAIL: branch-2 not found"; exit 1; }
echo "OK: both branches ran"

# Winner should be declared
echo "$OUTPUT" | grep -q "Winner\|No winner" || { echo "FAIL: no winner declared"; exit 1; }
echo "OK: winner declared"

# Cost reported
echo "$OUTPUT" | grep -q 'Cost: \$' || { echo "FAIL: no cost"; exit 1; }
echo "OK: cost reported"

# Cleanup
deno run --allow-all src/cli.ts cleanup --all > /dev/null 2>&1
rm -f bus-race-*.jsonl

echo ""
echo "All race tests passed (3/3)"
echo "PASS"
