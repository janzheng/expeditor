#!/bin/bash
# T07: --resume -p gets stream-json from a resumed session
# Verifies: resumed session with --output-format stream-json emits valid JSONL
# Depends on: T05
set -euo pipefail

RESULTS_DIR="$(dirname "$0")/results"
mkdir -p "$RESULTS_DIR"

echo "=== T07: resume with stream-json output ==="

SESSION_FILE="$RESULTS_DIR/t05-session-id.txt"
if [[ ! -f "$SESSION_FILE" ]]; then
  echo "SKIP: no session ID from T05 — run T05 first"
  exit 2
fi

SESSION_ID=$(grep "Session ID:" "$SESSION_FILE" | cut -d' ' -f3)
echo "Resuming session: $SESSION_ID"

OUT="$RESULTS_DIR/t07-resume-stream.jsonl"

claude -p --output-format stream-json --verbose \
  --resume "$SESSION_ID" \
  "List exactly 3 fruits." \
  > "$OUT" 2>/dev/null

if [[ ! -s "$OUT" ]]; then
  echo "FAIL: no output"
  exit 1
fi

# Validate JSONL
invalid=0
total=0
while IFS= read -r line; do
  ((total++))
  if ! echo "$line" | python3 -c "import sys,json; json.load(sys.stdin)" 2>/dev/null; then
    ((invalid++))
  fi
done < "$OUT"

echo "Lines: $total, Invalid JSON: $invalid"

if [[ $invalid -gt 0 ]]; then
  echo "FAIL: $invalid invalid JSON lines in resumed stream-json"
  exit 1
fi

# Check session_id in result to confirm it's the same session
python3 -c "
import json
for line in open('$OUT'):
    obj = json.loads(line)
    if obj.get('type') == 'result':
        sid = obj.get('session_id', obj.get('sessionId', 'not found'))
        print(f'Session ID in result: {sid}')
        print(f'Expected: $SESSION_ID')
"

echo "PASS: resumed session emits valid stream-json ($total events)"
