#!/bin/bash
# T01: Claude adapter parses stream-json into normalized signals
set -euo pipefail

RESULTS_DIR="$(cd "$(dirname "$0")" && pwd)/results"
PROJECT_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
mkdir -p "$RESULTS_DIR"

echo "=== T01: Claude adapter parsing ==="

TMPFILE=$(mktemp /tmp/t01-XXXXXX.ts)
cat > "$TMPFILE" << TSEOF
import { parseStreamJsonLine } from "file://$PROJECT_ROOT/src/claude-adapter.ts";
const opts = { agentId: "test-agent", parentId: undefined };

let pass = 0;
function ok(msg: string) { pass++; console.log("OK: " + msg); }

// system → spawned
const s = parseStreamJsonLine(JSON.stringify({type:"system",subtype:"init",session_id:"abc",cwd:"/tmp",model:"opus",tools:["Bash"]}), opts);
console.assert(s.length===1 && s[0].type==="spawned" && s[0].sessionId==="abc"); ok("system → spawned");

// tool_use → tool_call
const tc = parseStreamJsonLine(JSON.stringify({type:"assistant",session_id:"abc",message:{content:[{type:"tool_use",id:"t1",name:"Read",input:{file_path:"/etc/shells"}}]}}), opts);
console.assert(tc.length===1 && tc[0].type==="tool_call" && (tc[0].payload as any).tool==="Read"); ok("tool_use → tool_call");

// Agent → isSubagent
const sa = parseStreamJsonLine(JSON.stringify({type:"assistant",session_id:"abc",message:{content:[{type:"tool_use",id:"t2",name:"Agent",input:{description:"find files",prompt:"ls"}}]}}), opts);
console.assert(sa.length===1 && (sa[0].payload as any).isSubagent===true); ok("Agent → isSubagent");

// text → output
const tx = parseStreamJsonLine(JSON.stringify({type:"assistant",session_id:"abc",message:{content:[{type:"text",text:"Hello"}]}}), opts);
console.assert(tx.length===1 && tx[0].type==="output"); ok("text → output");

// thinking → progress
const th = parseStreamJsonLine(JSON.stringify({type:"assistant",session_id:"abc",message:{content:[{type:"thinking",thinking:"hmm"}]}}), opts);
console.assert(th.length===1 && th[0].type==="progress"); ok("thinking → progress");

// result → done + cost
const r = parseStreamJsonLine(JSON.stringify({type:"result",session_id:"abc",is_error:false,result:"ok",stop_reason:"end_turn",duration_ms:5000,num_turns:2,total_cost_usd:0.05,usage:{input_tokens:100,output_tokens:50,cache_read_input_tokens:200,cache_creation_input_tokens:0}}), opts);
console.assert(r.length===2 && r[0].type==="done" && r[1].type==="cost" && (r[1].payload as any).totalCostUsd===0.05); ok("result → done + cost");

// error result → failed
const e = parseStreamJsonLine(JSON.stringify({type:"result",session_id:"abc",is_error:true,result:"broke",duration_ms:1000,total_cost_usd:0.01,usage:{input_tokens:10,output_tokens:5}}), opts);
console.assert(e[0].type==="failed"); ok("error → failed");

// rate_limit → skip
const rl = parseStreamJsonLine(JSON.stringify({type:"rate_limit_event"}), opts);
console.assert(rl.length===0); ok("rate_limit → skip");

// bad JSON → empty
console.assert(parseStreamJsonLine("nope", opts).length===0); ok("bad JSON → empty");

// multi-content
const m = parseStreamJsonLine(JSON.stringify({type:"assistant",session_id:"abc",message:{content:[{type:"tool_use",id:"t3",name:"Bash",input:{command:"ls"}},{type:"text",text:"files"}]}}), opts);
console.assert(m.length===2 && m[0].type==="tool_call" && m[1].type==="output"); ok("multi-content → 2 signals");

console.log("\nAll adapter tests passed (" + pass + "/10)");
TSEOF

deno run --allow-all "$TMPFILE"
rm -f "$TMPFILE"
echo "PASS"
