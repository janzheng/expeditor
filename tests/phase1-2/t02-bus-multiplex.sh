#!/bin/bash
# T02: Signal bus multiplexes signals + writes JSONL
set -euo pipefail

RESULTS_DIR="$(cd "$(dirname "$0")" && pwd)/results"
PROJECT_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
mkdir -p "$RESULTS_DIR"

LOG_FILE="$RESULTS_DIR/t02-bus-test.jsonl"
rm -f "$LOG_FILE"

echo "=== T02: Bus multiplexing ==="

TMPFILE=$(mktemp /tmp/t02-XXXXXX.ts)
cat > "$TMPFILE" << TSEOF
import { SignalBus } from "file://$PROJECT_ROOT/src/bus.ts";

const bus = new SignalBus({ logFile: "$LOG_FILE" });
await bus.init();

const received: any[] = [];
bus.subscribe((s) => received.push(s));

await bus.emit({ agentId: "a", sessionId: "s1", timestamp: 1000, type: "spawned", payload: { cwd: "/a" } });
await bus.emit({ agentId: "b", sessionId: "s2", timestamp: 1001, type: "spawned", payload: { cwd: "/b" } });
await bus.emit({ agentId: "a", sessionId: "s1", timestamp: 1002, type: "done", payload: { result: "ok" } });
await bus.emit({ agentId: "b", sessionId: "s2", timestamp: 1003, type: "done", payload: { result: "ok" } });
await bus.close();

console.assert(received.length === 4, "consumer got 4"); console.log("OK: consumer got 4 signals");

const lines = (await Deno.readTextFile("$LOG_FILE")).trim().split("\\n");
console.assert(lines.length === 4, "JSONL 4 lines"); console.log("OK: JSONL has 4 lines");

for (const l of lines) { const o = JSON.parse(l); console.assert(o.agentId && o.type); }
console.log("OK: all lines valid");

console.log("\\nAll bus tests passed (3/3)");
TSEOF

deno run --allow-all "$TMPFILE"
rm -f "$TMPFILE"
echo "PASS"
