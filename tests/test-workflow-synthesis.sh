#!/bin/bash
# Test: End-to-end workflow synthesis
# Verifies: fan-out agents -> write outputs -> synthesis agent reads them -> final result
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RESULTS_DIR="$PROJECT_ROOT/tests/results"
mkdir -p "$RESULTS_DIR"

echo "=== Test: Workflow Synthesis (end-to-end) ==="
echo "  This test spawns real Claude agents and may take 3+ minutes."
echo ""

# Clean up prior test output
rm -rf "$PROJECT_ROOT/.expo/output/"

cd "$PROJECT_ROOT"

# Run the workflow
echo "Running workflow..."
OUTPUT=$(deno run --allow-all src/cli.ts workflow tests/test-workflow.md --timeout 120 --budget 2 2>&1) || true
echo "$OUTPUT" > "$RESULTS_DIR/test-workflow-synthesis-output.txt"
echo "Workflow finished. Output saved to tests/results/test-workflow-synthesis-output.txt"
echo ""

PASS_COUNT=0
FAIL_COUNT=0

# Check 1: CLI exited without a fatal parse/spawn error (workflow line appears)
if echo "$OUTPUT" | grep -q "Workflow"; then
  echo "OK: Workflow command recognized and started"
  PASS_COUNT=$((PASS_COUNT + 1))
else
  echo "FAIL: Workflow command did not start properly"
  FAIL_COUNT=$((FAIL_COUNT + 1))
fi

# Check 2: Both agents were spawned
if echo "$OUTPUT" | grep -q "file-scanner" && echo "$OUTPUT" | grep -q "line-counter"; then
  echo "OK: Both agents (file-scanner, line-counter) were spawned"
  PASS_COUNT=$((PASS_COUNT + 1))
else
  echo "FAIL: Not all agents were spawned"
  FAIL_COUNT=$((FAIL_COUNT + 1))
fi

# Check 3: At least one agent result file exists
AGENT_FILES_FOUND=0
if [ -f "$PROJECT_ROOT/.expo/output/file-scanner.md" ]; then
  AGENT_FILES_FOUND=$((AGENT_FILES_FOUND + 1))
  echo "OK: file-scanner output exists"
fi
if [ -f "$PROJECT_ROOT/.expo/output/line-counter.md" ]; then
  AGENT_FILES_FOUND=$((AGENT_FILES_FOUND + 1))
  echo "OK: line-counter output exists"
fi

if [ "$AGENT_FILES_FOUND" -gt 0 ]; then
  echo "OK: $AGENT_FILES_FOUND agent result file(s) found"
  PASS_COUNT=$((PASS_COUNT + 1))
else
  echo "FAIL: No agent result files found in .expo/output/"
  FAIL_COUNT=$((FAIL_COUNT + 1))
fi

# Check 4: Synthesis output file exists
if [ -f "$PROJECT_ROOT/.expo/output/test-synthesis.md" ]; then
  SYNTH_SIZE=$(wc -c < "$PROJECT_ROOT/.expo/output/test-synthesis.md" | tr -d ' ')
  echo "OK: Synthesis output exists ($SYNTH_SIZE bytes)"
  PASS_COUNT=$((PASS_COUNT + 1))
else
  echo "FAIL: Synthesis output file .expo/output/test-synthesis.md not found"
  FAIL_COUNT=$((FAIL_COUNT + 1))
fi

# Check 5: Synthesis output has some content (not empty)
if [ -f "$PROJECT_ROOT/.expo/output/test-synthesis.md" ] && [ -s "$PROJECT_ROOT/.expo/output/test-synthesis.md" ]; then
  echo "OK: Synthesis output is non-empty"
  PASS_COUNT=$((PASS_COUNT + 1))
else
  echo "FAIL: Synthesis output is missing or empty"
  FAIL_COUNT=$((FAIL_COUNT + 1))
fi

# Cleanup agents
deno run --allow-all src/cli.ts cleanup --all > /dev/null 2>&1 || true

echo ""
echo "Results: $PASS_COUNT passed, $FAIL_COUNT failed (out of $((PASS_COUNT + FAIL_COUNT)))"

if [ "$FAIL_COUNT" -eq 0 ]; then
  echo "PASS"
  exit 0
else
  echo "FAIL"
  exit 1
fi
