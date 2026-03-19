#!/bin/bash
# T11: TUI dashboard renders agent cards from JSONL
set -euo pipefail

RESULTS_DIR="$(cd "$(dirname "$0")" && pwd)/results"
PROJECT_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
mkdir -p "$RESULTS_DIR"

echo "=== T11: TUI dashboard ==="

# Create test bus
TESTBUS="$RESULTS_DIR/t11-test-bus.jsonl"
cat > "$TESTBUS" << 'EOF'
{"agentId":"agent-a","sessionId":"s1","timestamp":1710000001000,"type":"spawned","payload":{"cwd":"/tmp","model":"opus","tools":[]}}
{"agentId":"agent-b","sessionId":"s2","timestamp":1710000002000,"type":"spawned","payload":{"cwd":"/tmp","model":"sonnet","tools":[]}}
{"agentId":"agent-a","sessionId":"s1","timestamp":1710000003000,"type":"tool_call","payload":{"toolUseId":"t1","tool":"Read","input":{"file_path":"test.ts"},"isSubagent":false}}
{"agentId":"agent-a","sessionId":"s1","timestamp":1710000004000,"type":"tool_result","payload":{"toolUseId":"t1","isError":false}}
{"agentId":"agent-a","sessionId":"s1","timestamp":1710000005000,"type":"done","payload":{"result":"ok","stopReason":"end_turn","durationMs":4000,"numTurns":2}}
{"agentId":"agent-a","sessionId":"s1","timestamp":1710000005000,"type":"cost","payload":{"totalCostUsd":0.05,"durationMs":4000,"inputTokens":100,"outputTokens":50}}
{"agentId":"agent-b","sessionId":"s2","timestamp":1710000006000,"type":"failed","payload":{"error":"timeout"}}
{"agentId":"agent-b","sessionId":"s2","timestamp":1710000006000,"type":"cost","payload":{"totalCostUsd":0.02,"durationMs":3000,"inputTokens":80,"outputTokens":10}}
EOF

cd "$PROJECT_ROOT"
OUTPUT=$(deno run --allow-all src/tui.tsx "$TESTBUS" 2>&1)
echo "$OUTPUT" > "$RESULTS_DIR/t11-tui-output.txt"

# Check both agents render
echo "$OUTPUT" | grep -q "agent-a" || { echo "FAIL: agent-a not in output"; exit 1; }
echo "$OUTPUT" | grep -q "agent-b" || { echo "FAIL: agent-b not in output"; exit 1; }
echo "OK: both agents rendered"

# Check dashboard header
echo "$OUTPUT" | grep -q "expo dashboard" || { echo "FAIL: no dashboard header"; exit 1; }
echo "$OUTPUT" | grep -q "2 agents" || { echo "FAIL: agent count wrong"; exit 1; }
echo "OK: dashboard header with agent count"

# Check cost summary
echo "$OUTPUT" | grep -q "0.07" || { echo "FAIL: total cost not shown"; exit 1; }
echo "OK: cost aggregated"

# Check card borders render (box drawing chars)
echo "$OUTPUT" | grep -q "╭\|╰\|│" || { echo "FAIL: no card borders"; exit 1; }
echo "OK: card borders rendered"

rm -f "$TESTBUS"

echo ""
echo "All TUI tests passed (4/4)"
echo "PASS"
