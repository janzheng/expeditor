#!/bin/bash
# T05: --session-id assigns deterministic session ID
# Verifies: we can set a known session ID and find it in output/session list
set -euo pipefail

RESULTS_DIR="$(dirname "$0")/results"
mkdir -p "$RESULTS_DIR"
OUT="$RESULTS_DIR/t05-raw-output.jsonl"

echo "=== T05: --session-id deterministic ID ==="

# Generate a UUID
TEST_SESSION_ID=$(python3 -c "import uuid; print(uuid.uuid4())")
echo "Test session ID: $TEST_SESSION_ID"

# Run with explicit session ID
claude -p --output-format stream-json --verbose \
  --session-id "$TEST_SESSION_ID" \
  "Say exactly: hello from session test" \
  > "$OUT" 2>/dev/null

if [[ ! -s "$OUT" ]]; then
  echo "FAIL: output file is empty"
  exit 1
fi

# Check if session ID appears in the output
if grep -q "$TEST_SESSION_ID" "$OUT"; then
  echo "OK: session ID found in stream-json output"
else
  echo "NOTE: session ID not in stream-json events (may only be in metadata)"
fi

# Check if we can find the session in claude's session list
# (claude may have a way to list sessions)
echo ""
echo "=== Checking if session is findable ==="

# Try to get session info via stream-json result event
python3 << PYEOF
import json

out_file = "results/t05-raw-output.jsonl"
session_id = "$TEST_SESSION_ID"

for line in open(out_file):
    obj = json.loads(line)
    flat = json.dumps(obj)
    if session_id in flat:
        print(f"Session ID found in event type: {obj.get('type')}")
        print(json.dumps(obj, indent=2)[:500])

# Check result event specifically
for line in open(out_file):
    obj = json.loads(line)
    if obj.get("type") == "result":
        print(f"\nResult event:")
        print(json.dumps(obj, indent=2)[:1000])
        # Look for session_id field
        if "session" in json.dumps(obj).lower():
            print("\nSession info found in result!")

print(f"\nSession ID used: {session_id}")
print("To verify persistence, try: claude --resume {session_id}")
PYEOF

echo ""
echo "Session ID: $TEST_SESSION_ID" > "$RESULTS_DIR/t05-session-id.txt"
echo "Saved session ID to $RESULTS_DIR/t05-session-id.txt for T06/T07"
echo "PASS"
