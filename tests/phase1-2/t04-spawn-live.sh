#!/bin/bash
# T04: Full spawn → signals → registry → cleanup cycle (live claude call)
set -euo pipefail

RESULTS_DIR="$(cd "$(dirname "$0")" && pwd)/results"
PROJECT_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
mkdir -p "$RESULTS_DIR"

echo "=== T04: Spawn → signals → registry → cleanup ==="

# Clean slate
rm -f "$PROJECT_ROOT/.sigbus/registry.json"

# Spawn
cd "$PROJECT_ROOT"
OUTPUT=$(deno run --allow-all src/cli.ts spawn "Say exactly: test-pass" --name t04-agent --no-worktree 2>&1)
echo "$OUTPUT" > "$RESULTS_DIR/t04-spawn-output.txt"

# Check output has expected signals
echo "$OUTPUT" | grep -q "spawned" || { echo "FAIL: no spawned signal"; exit 1; }
echo "$OUTPUT" | grep -q "done" || { echo "FAIL: no done signal"; exit 1; }
echo "$OUTPUT" | grep -q "success" || { echo "FAIL: not successful"; exit 1; }
echo "OK: spawn produced spawned + done + success"

# Check registry has the agent
STATUS=$(deno run --allow-all src/cli.ts status 2>&1)
echo "$STATUS" | grep -q "t04-agent" || { echo "FAIL: agent not in registry"; exit 1; }
echo "$STATUS" | grep -q "done" || { echo "FAIL: agent not marked done"; exit 1; }
echo "OK: registry shows agent as done"

# Extract session ID from status
SESSION_ID=$(echo "$STATUS" | grep "Session:" | head -1 | awk '{print $NF}' | tr -d '\033[2m\033[0m' | sed 's/\x1b\[[0-9;]*m//g')
echo "Session ID: $SESSION_ID"

# Cleanup
CLEANUP=$(deno run --allow-all src/cli.ts cleanup --all 2>&1)
echo "$CLEANUP" | grep -q "t04-agent" || { echo "FAIL: cleanup didn't find agent"; exit 1; }
echo "OK: cleanup removed agent"

# Verify empty registry
STATUS2=$(deno run --allow-all src/cli.ts status 2>&1)
echo "$STATUS2" | grep -q "No agents" || { echo "FAIL: registry not empty after cleanup"; exit 1; }
echo "OK: registry empty after cleanup"

echo ""
echo "All spawn lifecycle tests passed (4/4)"
echo "PASS"
