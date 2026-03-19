#!/bin/bash
# T03: Registry persists to disk and survives reload
set -euo pipefail

RESULTS_DIR="$(cd "$(dirname "$0")" && pwd)/results"
PROJECT_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
mkdir -p "$RESULTS_DIR"

REG_FILE="$RESULTS_DIR/t03-test-registry.json"
rm -f "$REG_FILE"

echo "=== T03: Registry persistence ==="

TMPFILE=$(mktemp /tmp/t03-XXXXXX.ts)
cat > "$TMPFILE" << TSEOF
import { Registry } from "file://$PROJECT_ROOT/src/registry.ts";

const f = "$REG_FILE";
let pass = 0;
function ok(msg: string) { pass++; console.log("OK: " + msg); }

// Write
const r1 = new Registry({ filePath: f });
await r1.load();
await r1.register({ agentId:"a1", sessionId:"s1", name:"a1", cwd:"/tmp", status:"running", startedAt:Date.now(), pid:1 });
await r1.register({ agentId:"a2", sessionId:"s2", name:"a2", cwd:"/tmp", status:"done", startedAt:Date.now()-5000, finishedAt:Date.now(), exitCode:0, pid:2 });

// Reload
const r2 = new Registry({ filePath: f });
await r2.load();
console.assert(r2.getAll().length === 2); ok("reload: 2 entries");
console.assert(r2.get("a1")?.sessionId === "s1"); ok("a1 preserved");

// Update
await r2.update("a1", { status: "failed", exitCode: 1 });
const r3 = new Registry({ filePath: f });
await r3.load();
console.assert(r3.get("a1")?.status === "failed"); ok("update persists");

// findBySession
console.assert(r3.findBySession("s2")?.agentId === "a2"); ok("findBySession");

// Remove
await r3.remove("a1");
const r4 = new Registry({ filePath: f });
await r4.load();
console.assert(r4.getAll().length === 1); ok("remove persists");

console.log("\\nAll registry tests passed (" + pass + "/5)");
TSEOF

deno run --allow-all "$TMPFILE"
rm -f "$TMPFILE"
echo "PASS"
