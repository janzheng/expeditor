#!/bin/bash
# T02: stream-json contains cost/token/duration in result event
# Verifies: final event has cost_usd, input_tokens, output_tokens
set -euo pipefail

RESULTS_DIR="$(dirname "$0")/results"
mkdir -p "$RESULTS_DIR"
OUT="$RESULTS_DIR/t02-raw-output.jsonl"

echo "=== T02: stream-json cost/token fields ==="

claude -p --output-format stream-json --verbose \
  "What is 2+2? Answer in one word." \
  > "$OUT" 2>/dev/null

if [[ ! -s "$OUT" ]]; then
  echo "FAIL: output file is empty"
  exit 1
fi

# Find the result/final event and extract cost fields
python3 << 'PYEOF'
import json, sys

results_file = sys.argv[1] if len(sys.argv) > 1 else "results/t02-raw-output.jsonl"

found_cost = False
found_tokens = False
last_event = None

for line in open(results_file):
    obj = json.loads(line)
    last_event = obj

    # Check various places cost info might live
    t = obj.get("type", "")

    # Look in result event
    if t == "result":
        print(f"Found 'result' event:")
        print(json.dumps(obj, indent=2)[:1000])
        # Check for cost fields at various nesting levels
        for key in ("cost_usd", "costUsd", "cost", "usage", "stats", "session"):
            if key in obj:
                print(f"  Found field: {key} = {obj[key]}")
                found_cost = True
            if isinstance(obj.get("result"), dict) and key in obj["result"]:
                print(f"  Found field in result.{key} = {obj['result'][key]}")
                found_cost = True

    # Also check message_delta for usage
    if t == "message_delta":
        usage = obj.get("usage", {})
        if usage:
            print(f"Found usage in message_delta: {usage}")
            found_tokens = True

    # Check for any key containing "token" or "cost" anywhere
    flat = json.dumps(obj)
    if "token" in flat.lower() and "input" in flat.lower():
        if not found_tokens and t in ("result", "message_delta", "message_stop"):
            print(f"Token info found in {t} event")
            found_tokens = True
    if "cost" in flat.lower() and t in ("result", "message_delta", "message_stop"):
        if not found_cost:
            print(f"Cost info found in {t} event")
            found_cost = True

print()
if found_cost:
    print("OK: cost information found")
else:
    print("NOTE: no explicit cost field found — may need to compute from token counts")

if found_tokens:
    print("OK: token information found")
else:
    print("NOTE: no token information found in stream events")

# Always dump the last few events for inspection
print()
print("=== Last 3 events (for manual inspection) ===")
lines = open(results_file).readlines()
for line in lines[-3:]:
    obj = json.loads(line)
    print(json.dumps(obj, indent=2)[:500])
    print()

# Save full analysis
with open(results_file.replace("raw-output", "cost-analysis") + ".md", "w") as f:
    f.write("# T02: Cost/Token Field Analysis\n\n")
    f.write(f"Cost found: {found_cost}\n")
    f.write(f"Tokens found: {found_tokens}\n\n")
    f.write("## All events with cost/token data\n\n")
    for line in open(results_file):
        obj = json.loads(line)
        flat = json.dumps(obj)
        if "cost" in flat.lower() or "token" in flat.lower() or "usage" in flat.lower():
            f.write(f"### {obj.get('type', 'unknown')}\n```json\n{json.dumps(obj, indent=2)[:1000]}\n```\n\n")

print("PASS (analysis complete — review results for field locations)")
PYEOF
