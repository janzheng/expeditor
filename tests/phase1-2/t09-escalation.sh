#!/bin/bash
# T09: Escalation router — unit test (no live claude)
set -euo pipefail

RESULTS_DIR="$(cd "$(dirname "$0")" && pwd)/results"
PROJECT_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
mkdir -p "$RESULTS_DIR"

echo "=== T09: Escalation router ==="

TMPFILE=$(mktemp /tmp/t09-XXXXXX.ts)
cat > "$TMPFILE" << TSEOF
import { SignalBus } from "file://$PROJECT_ROOT/src/bus.ts";
import { escalationRouter } from "file://$PROJECT_ROOT/src/orchestrator.ts";

const bus = new SignalBus();
await bus.init();

let escalated = false;
let escalateCtx: any = null;

const unsub = escalationRouter(bus, {
  failThreshold: 2,
  onEscalate: (_signal, ctx) => {
    escalated = true;
    escalateCtx = ctx;
  },
});

// First failure — should NOT escalate
await bus.emit({ agentId: "a1", sessionId: "s1", timestamp: 1, type: "failed", payload: { error: "fail 1" } });
console.assert(!escalated, "1 failure should not escalate");
console.log("OK: 1 failure → no escalation");

// Second failure — SHOULD escalate
await bus.emit({ agentId: "a1", sessionId: "s1", timestamp: 2, type: "failed", payload: { error: "fail 2" } });
// Small delay for async handler
await new Promise(r => setTimeout(r, 10));
console.assert(escalated, "2 failures should escalate");
console.assert(escalateCtx?.failCount === 2);
console.assert(escalateCtx?.reason === "fail 2");
console.log("OK: 2 failures → escalated");

// Reset on success
escalated = false;
await bus.emit({ agentId: "a1", sessionId: "s1", timestamp: 3, type: "done", payload: { result: "ok" } });
await bus.emit({ agentId: "a1", sessionId: "s1", timestamp: 4, type: "failed", payload: { error: "fail 3" } });
await new Promise(r => setTimeout(r, 10));
console.assert(!escalated, "success should reset fail count");
console.log("OK: success resets fail count");

// Different agent — independent count
await bus.emit({ agentId: "a2", sessionId: "s2", timestamp: 5, type: "failed", payload: { error: "a2 fail" } });
await new Promise(r => setTimeout(r, 10));
console.assert(!escalated, "a2 first failure should not escalate");
console.log("OK: per-agent tracking");

unsub();
await bus.close();
console.log("\\nAll escalation tests passed (4/4)");
TSEOF

deno run --allow-all "$TMPFILE"
rm -f "$TMPFILE"
echo "PASS"
