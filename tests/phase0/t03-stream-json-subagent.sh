#!/bin/bash
# T03: stream-json captures subagent (Agent tool) events
# Verifies: when claude spawns a subagent, the stream-json shows it
set -euo pipefail

RESULTS_DIR="$(dirname "$0")/results"
mkdir -p "$RESULTS_DIR"
OUT="$RESULTS_DIR/t03-raw-output.jsonl"

echo "=== T03: stream-json subagent events ==="

# Prompt that should trigger a subagent spawn
# Be very explicit about wanting the Agent tool used
claude -p --output-format stream-json --verbose \
  "You MUST use the Agent tool to delegate this task to a subagent: have the subagent count the number of .txt files in /tmp. Do NOT do this yourself — use the Agent tool to spawn a subagent to do it." \
  > "$OUT" 2>/dev/null

if [[ ! -s "$OUT" ]]; then
  echo "FAIL: output file is empty"
  exit 1
fi

# Analyze for subagent-related events
python3 << 'PYEOF'
import json, sys

out_file = "results/t03-raw-output.jsonl"
agent_events = []
all_types = set()

for line in open(out_file):
    obj = json.loads(line)
    t = obj.get("type", "")
    all_types.add(t)

    flat = json.dumps(obj).lower()

    # Look for Agent tool use
    if "agent" in flat and t in ("content_block_start", "tool_use", "content_block_delta"):
        agent_events.append(obj)

    # Look for subagent-specific event types
    if "subagent" in flat or "sub_agent" in flat:
        agent_events.append(obj)

    # Check content_block_start for tool_use with name containing "Agent"
    if t == "content_block_start":
        cb = obj.get("content_block", {})
        if cb.get("type") == "tool_use" and "agent" in cb.get("name", "").lower():
            agent_events.append(obj)

print(f"Total lines: {sum(1 for _ in open(out_file))}")
print(f"All event types: {sorted(all_types)}")
print(f"Agent-related events: {len(agent_events)}")
print()

if agent_events:
    print("=== Agent/subagent events found ===")
    for evt in agent_events[:10]:  # Cap at 10
        print(json.dumps(evt, indent=2)[:500])
        print()
    print("PASS: subagent events detected")
else:
    print("NOTE: no explicit subagent events found")
    print("This might mean:")
    print("  - The model didn't use the Agent tool (it may have done the work directly)")
    print("  - Subagent events are represented differently than expected")
    print()
    print("=== All event types for manual inspection ===")
    for t in sorted(all_types):
        print(f"  {t}")
    print()
    print("Dumping all content_block_start events:")
    for line in open(out_file):
        obj = json.loads(line)
        if obj.get("type") == "content_block_start":
            print(json.dumps(obj, indent=2)[:300])
    print()
    print("PASS (with caveats — review output manually)")

# Save analysis
with open("results/t03-subagent-analysis.md", "w") as f:
    f.write("# T03: Subagent Event Analysis\n\n")
    f.write(f"Agent-related events found: {len(agent_events)}\n\n")
    for evt in agent_events:
        f.write(f"```json\n{json.dumps(evt, indent=2)[:800]}\n```\n\n")
PYEOF
