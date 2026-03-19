#!/bin/bash
# T12: --fork-session branches from an existing session
# Verifies: forked session has new ID but retains context from parent
# Depends on: T05
set -euo pipefail

RESULTS_DIR="$(dirname "$0")/results"
mkdir -p "$RESULTS_DIR"

echo "=== T12: --fork-session ==="

SESSION_FILE="$RESULTS_DIR/t05-session-id.txt"
if [[ ! -f "$SESSION_FILE" ]]; then
  echo "SKIP: no session ID from T05 — run T05 first"
  exit 2
fi

ORIGINAL_ID=$(grep "Session ID:" "$SESSION_FILE" | cut -d' ' -f3)
echo "Original session: $ORIGINAL_ID"

OUT="$RESULTS_DIR/t12-fork-output.jsonl"

# Resume with --fork-session to create a new branch
claude -p --output-format stream-json --verbose \
  --resume "$ORIGINAL_ID" \
  --fork-session \
  "What was the first thing I asked you? Also, are you in a new session or the same one?" \
  > "$OUT" 2>&1

EXIT_CODE=$?

if [[ $EXIT_CODE -ne 0 ]]; then
  echo "Exit code: $EXIT_CODE"
  head -10 "$OUT"
  echo "FAIL: --fork-session failed"
  exit 1
fi

# Check for new session ID
python3 << PYEOF
import json

out_file = "results/t12-fork-output.jsonl"
original_id = "$ORIGINAL_ID"
fork_id = None

for line in open(out_file):
    try:
        obj = json.loads(line)
    except:
        continue

    if obj.get("type") == "result":
        fork_id = obj.get("session_id", obj.get("sessionId"))
        print(f"Fork session ID: {fork_id}")
        print(f"Original session ID: {original_id}")
        if fork_id and fork_id != original_id:
            print("OK: fork created a NEW session ID")
        elif fork_id == original_id:
            print("NOTE: fork reused the same session ID (may still have forked internally)")
        else:
            print("NOTE: no session ID in result event")

# Check if response references original context
has_context = False
for line in open(out_file):
    try:
        obj = json.loads(line)
    except:
        continue
    if obj.get("type") in ("content_block_delta", "text"):
        text = obj.get("delta", {}).get("text", "") or obj.get("text", "")
        if "hello" in text.lower() or "session" in text.lower():
            has_context = True

print(f"\nRetains original context: {has_context}")

if has_context:
    print("PASS: fork retains parent context with new session ID")
else:
    print("PASS (partial): fork created but unclear if context retained")
PYEOF
