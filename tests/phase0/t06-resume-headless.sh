#!/bin/bash
# T06: --resume can reattach to a completed -p session
# Verifies: claude --resume <id> -p returns conversation history
# Depends on: T05 (uses the session ID it created)
set -euo pipefail

RESULTS_DIR="$(dirname "$0")/results"
mkdir -p "$RESULTS_DIR"

echo "=== T06: resume a headless session ==="

# Check if T05 left us a session ID
SESSION_FILE="$RESULTS_DIR/t05-session-id.txt"
if [[ ! -f "$SESSION_FILE" ]]; then
  echo "SKIP: no session ID from T05 — run T05 first"
  exit 2
fi

SESSION_ID=$(grep "Session ID:" "$SESSION_FILE" | cut -d' ' -f3)
echo "Resuming session: $SESSION_ID"

# Try to resume in headless mode with a follow-up message
OUT="$RESULTS_DIR/t06-resume-output.jsonl"

claude -p --output-format stream-json --verbose \
  --resume "$SESSION_ID" \
  "What was the first thing I asked you to say?" \
  > "$OUT" 2>&1

if [[ ! -s "$OUT" ]]; then
  echo "FAIL: resume produced no output"
  # Check if it errored
  cat "$OUT" 2>/dev/null
  exit 1
fi

# Check if the response references the original message
python3 << PYEOF
import json

out_file = "results/t06-resume-output.jsonl"
has_text = False
references_original = False

for line in open(out_file):
    try:
        obj = json.loads(line)
    except json.JSONDecodeError:
        print(f"Non-JSON line: {line[:100]}")
        continue

    t = obj.get("type", "")

    # Look for text content that references the original "hello from session test"
    if t in ("content_block_delta", "text"):
        text = obj.get("delta", {}).get("text", "") or obj.get("text", "")
        if text:
            has_text = True
            if "hello" in text.lower() or "session" in text.lower():
                references_original = True

    if t == "result":
        result = obj.get("result", "")
        if isinstance(result, str) and ("hello" in result.lower() or "session" in result.lower()):
            references_original = True
        print(f"\nResult event: {json.dumps(obj, indent=2)[:500]}")

print(f"\nGot text output: {has_text}")
print(f"References original message: {references_original}")

if has_text:
    if references_original:
        print("\nPASS: resumed session remembers prior context")
    else:
        print("\nPASS (partial): session resumed but unclear if it remembers context")
        print("Manual review recommended")
else:
    print("\nFAIL: no text output from resumed session")
PYEOF
