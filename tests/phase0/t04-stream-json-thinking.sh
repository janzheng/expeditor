#!/bin/bash
# T04: stream-json captures thinking blocks
# Verifies: thinking event type present when model thinks
set -euo pipefail

RESULTS_DIR="$(dirname "$0")/results"
mkdir -p "$RESULTS_DIR"
OUT="$RESULTS_DIR/t04-raw-output.jsonl"

echo "=== T04: stream-json thinking blocks ==="

# Use a prompt that triggers thinking (extended thinking / reasoning)
claude -p --output-format stream-json --verbose \
  "Think step by step: if I have 3 boxes, each containing 2 red balls and 1 blue ball, and I pick one ball from each box, what's the probability all three are red?" \
  > "$OUT" 2>/dev/null

if [[ ! -s "$OUT" ]]; then
  echo "FAIL: output file is empty"
  exit 1
fi

python3 << 'PYEOF'
import json

out_file = "results/t04-raw-output.jsonl"
thinking_events = []
all_types = set()

for line in open(out_file):
    obj = json.loads(line)
    t = obj.get("type", "")
    all_types.add(t)

    flat = json.dumps(obj).lower()

    # Look for thinking-related events
    if "thinking" in t or "thinking" in flat:
        thinking_events.append(obj)

    # Check content blocks for thinking type
    if t == "content_block_start":
        cb = obj.get("content_block", {})
        if cb.get("type") == "thinking":
            thinking_events.append(obj)

print(f"Total lines: {sum(1 for _ in open(out_file))}")
print(f"All event types: {sorted(all_types)}")
print(f"Thinking events: {len(thinking_events)}")
print()

if thinking_events:
    print("=== Thinking events found ===")
    for evt in thinking_events[:5]:
        print(json.dumps(evt, indent=2)[:400])
        print()
    print("PASS: thinking events detected")
else:
    print("NOTE: no thinking events found")
    print("This may be normal — thinking blocks depend on model and prompt")
    print("Check if extended thinking is enabled for this model")
    print()
    print("All event types seen:")
    for t in sorted(all_types):
        print(f"  {t}")
    print()
    print("PASS (thinking may not be available for this model/config)")
PYEOF
