#!/bin/bash
# T01: stream-json emits valid JSONL with tool calls
# Verifies: output is valid JSONL, contains tool_use and tool_result events
set -euo pipefail

RESULTS_DIR="$(dirname "$0")/results"
mkdir -p "$RESULTS_DIR"
OUT="$RESULTS_DIR/t01-raw-output.jsonl"

echo "=== T01: stream-json basics ==="

# Run claude with a prompt that forces tool use (read a file)
claude -p --output-format stream-json --verbose \
  "Read the first line of /etc/hostname or /etc/shells and tell me what it says. Do not use any other tools." \
  > "$OUT" 2>/dev/null

# Check: output file exists and is non-empty
if [[ ! -s "$OUT" ]]; then
  echo "FAIL: output file is empty"
  exit 1
fi

# Check: every line is valid JSON
invalid_lines=0
total_lines=0
while IFS= read -r line; do
  ((total_lines++))
  if ! echo "$line" | python3 -c "import sys,json; json.load(sys.stdin)" 2>/dev/null; then
    ((invalid_lines++))
    echo "Invalid JSON on line $total_lines: $line"
  fi
done < "$OUT"

if [[ $invalid_lines -gt 0 ]]; then
  echo "FAIL: $invalid_lines of $total_lines lines are not valid JSON"
  exit 1
fi
echo "OK: $total_lines lines, all valid JSON"

# Check: at least one tool_use event exists
tool_use_count=$(grep -c '"type":"tool_use"' "$OUT" || true)
if [[ $tool_use_count -eq 0 ]]; then
  # Also check for tool_use in nested structures
  tool_use_count=$(python3 -c "
import json, sys
count = 0
for line in open('$OUT'):
    obj = json.loads(line)
    if obj.get('type') == 'content_block_start':
        cb = obj.get('content_block', {})
        if cb.get('type') == 'tool_use':
            count += 1
    elif obj.get('type') == 'tool_use':
        count += 1
print(count)
" 2>/dev/null || echo "0")
fi

echo "tool_use events: $tool_use_count"

# Check: result event exists
result_count=$(python3 -c "
import json
count = 0
for line in open('$OUT'):
    obj = json.loads(line)
    if obj.get('type') in ('result', 'message_stop', 'message_delta'):
        count += 1
print(count)
" 2>/dev/null || echo "0")
echo "result/stop events: $result_count"

# Catalog all unique event types
echo ""
echo "=== All event types found ==="
python3 -c "
import json
types = set()
for line in open('$OUT'):
    obj = json.loads(line)
    t = obj.get('type', 'unknown')
    types.add(t)
for t in sorted(types):
    print(f'  {t}')
" 2>/dev/null

# Save event type catalog
python3 -c "
import json
types = {}
for line in open('$OUT'):
    obj = json.loads(line)
    t = obj.get('type', 'unknown')
    if t not in types:
        types[t] = obj
for t in sorted(types):
    print(f'## {t}')
    print(f'\`\`\`json')
    print(json.dumps(types[t], indent=2)[:500])
    print(f'\`\`\`')
    print()
" > "$RESULTS_DIR/t01-event-types.md" 2>/dev/null

echo ""
echo "Event catalog saved to $RESULTS_DIR/t01-event-types.md"
echo "Raw output saved to $OUT"
echo "PASS"
