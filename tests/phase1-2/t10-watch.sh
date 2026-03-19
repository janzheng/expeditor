#!/bin/bash
# T10: Watch — replay JSONL bus file with pretty printing + summary
set -euo pipefail

RESULTS_DIR="$(cd "$(dirname "$0")" && pwd)/results"
PROJECT_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
mkdir -p "$RESULTS_DIR"

echo "=== T10: Watch ==="

# Create a test JSONL file
TESTBUS="$RESULTS_DIR/t10-test-bus.jsonl"
cat > "$TESTBUS" << 'EOF'
{"agentId":"agent-a","sessionId":"s1","timestamp":1710000001000,"type":"spawned","payload":{"cwd":"/tmp","model":"opus","tools":["Bash"]}}
{"agentId":"agent-a","sessionId":"s1","timestamp":1710000002000,"type":"tool_call","payload":{"toolUseId":"t1","tool":"Read","input":{"file_path":"test.ts"},"isSubagent":false}}
{"agentId":"agent-a","sessionId":"s1","timestamp":1710000003000,"type":"tool_result","payload":{"toolUseId":"t1","result":"file contents","isError":false}}
{"agentId":"agent-b","sessionId":"s2","timestamp":1710000002500,"type":"spawned","payload":{"cwd":"/tmp","model":"sonnet","tools":["Bash"]}}
{"agentId":"agent-a","sessionId":"s1","timestamp":1710000004000,"type":"output","payload":{"text":"All done!"}}
{"agentId":"agent-a","sessionId":"s1","timestamp":1710000005000,"type":"done","payload":{"result":"ok","stopReason":"end_turn","durationMs":4000,"numTurns":2}}
{"agentId":"agent-a","sessionId":"s1","timestamp":1710000005000,"type":"cost","payload":{"totalCostUsd":0.05,"durationMs":4000,"inputTokens":100,"outputTokens":50}}
{"agentId":"agent-b","sessionId":"s2","timestamp":1710000006000,"type":"failed","payload":{"error":"timeout","exitCode":1}}
{"agentId":"agent-b","sessionId":"s2","timestamp":1710000006000,"type":"cost","payload":{"totalCostUsd":0.02,"durationMs":3500,"inputTokens":80,"outputTokens":10}}
EOF

cd "$PROJECT_ROOT"

# Test pretty print
OUTPUT=$(deno run --allow-read src/watch.ts "$TESTBUS" 2>&1)
echo "$OUTPUT" | grep -q "agent-a" || { echo "FAIL: agent-a not in output"; exit 1; }
echo "$OUTPUT" | grep -q "agent-b" || { echo "FAIL: agent-b not in output"; exit 1; }
echo "$OUTPUT" | grep -q "spawned" || { echo "FAIL: spawned not shown"; exit 1; }
echo "$OUTPUT" | grep -q "Read" || { echo "FAIL: tool_call not shown"; exit 1; }
echo "$OUTPUT" | grep -q "done" || { echo "FAIL: done not shown"; exit 1; }
echo "$OUTPUT" | grep -q "failed" || { echo "FAIL: failed not shown"; exit 1; }
echo "OK: pretty print shows all signal types"

# Test summary mode
SUMMARY=$(deno run --allow-read src/watch.ts "$TESTBUS" --summary 2>&1)
echo "$SUMMARY" | grep -q "Summary" || { echo "FAIL: no summary header"; exit 1; }
echo "$SUMMARY" | grep -q "2 agents" || { echo "FAIL: agent count wrong"; exit 1; }
echo "$SUMMARY" | grep -q "0.07" || { echo "FAIL: total cost wrong"; exit 1; }
echo "OK: summary shows agent count + total cost"

# Test JSON mode
JSON_OUT=$(deno run --allow-read src/watch.ts "$TESTBUS" --json 2>&1)
LINE_COUNT=$(echo "$JSON_OUT" | wc -l | tr -d ' ')
[[ $LINE_COUNT -eq 9 ]] || { echo "FAIL: expected 9 JSON lines, got $LINE_COUNT"; exit 1; }
echo "OK: JSON mode outputs raw lines"

rm -f "$TESTBUS"

echo ""
echo "All watch tests passed (3/3)"
echo "PASS"
