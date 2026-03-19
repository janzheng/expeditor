#!/bin/bash
# T05: Parallel spawn with multiplexed signals
set -euo pipefail

RESULTS_DIR="$(cd "$(dirname "$0")" && pwd)/results"
PROJECT_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
mkdir -p "$RESULTS_DIR"

echo "=== T05: Parallel spawn ==="

rm -f "$PROJECT_ROOT/.sigbus/registry.json"

# Create tasks file
TASKS_FILE="$RESULTS_DIR/t05-tasks.json"
cat > "$TASKS_FILE" << 'EOF'
[
  {"prompt": "Say: alpha", "name": "t05-alpha", "worktree": false},
  {"prompt": "Say: beta", "name": "t05-beta", "worktree": false}
]
EOF

cd "$PROJECT_ROOT"
OUTPUT=$(deno run --allow-all src/cli.ts spawn-all "$TASKS_FILE" 2>&1)
echo "$OUTPUT" > "$RESULTS_DIR/t05-spawn-output.txt"

# Both agents should appear
echo "$OUTPUT" | grep -q "t05-alpha" || { echo "FAIL: alpha not in output"; exit 1; }
echo "$OUTPUT" | grep -q "t05-beta" || { echo "FAIL: beta not in output"; exit 1; }
echo "OK: both agents in output"

# Both should succeed
ALPHA_OK=$(echo "$OUTPUT" | grep "t05-alpha:" | grep -c "success" || true)
BETA_OK=$(echo "$OUTPUT" | grep "t05-beta:" | grep -c "success" || true)
[[ $ALPHA_OK -ge 1 ]] || { echo "FAIL: alpha not successful"; exit 1; }
[[ $BETA_OK -ge 1 ]] || { echo "FAIL: beta not successful"; exit 1; }
echo "OK: both agents successful"

# Registry should have both
STATUS=$(deno run --allow-all src/cli.ts status 2>&1)
AGENT_COUNT=$(echo "$STATUS" | grep -c "●" || true)
[[ $AGENT_COUNT -ge 2 ]] || { echo "FAIL: expected 2 agents in registry, got $AGENT_COUNT"; exit 1; }
echo "OK: registry has 2 agents"

# Cleanup
deno run --allow-all src/cli.ts cleanup --all > /dev/null 2>&1
rm -f "$TASKS_FILE"

echo ""
echo "All parallel tests passed (3/3)"
echo "PASS"
