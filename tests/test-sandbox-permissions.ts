/**
 * Test: Research sandbox — which Bash commands get through?
 *
 * The research preset allows only: mkdir, ls, cat, head, curl, jq
 * Everything else should be denied (git, touch, sed, awk, etc.)
 */

import { SignalBus } from "../src/bus.ts";
import { AgentSpawner, SANDBOX_PRESETS } from "../src/spawner.ts";
import { Registry } from "../src/registry.ts";
import { withTimeout } from "../src/timeout.ts";

const logsDir = ".expo/logs";
await Deno.mkdir(logsDir, { recursive: true }).catch(() => {});

const logFile = `${logsDir}/bus-sandbox-test-${Date.now()}.jsonl`;
const bus = new SignalBus({ logFile });
await bus.init();

const registry = new Registry();
const spawner = new AgentSpawner(bus, { registry });
await spawner.init();

const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";

// Collect signals
const denials: string[] = [];
bus.subscribe((signal) => {
  if (signal.type === "done" || signal.type === "failed") {
    const p = signal.payload as Record<string, unknown>;
    const d = p.permissionDenials as string[] | undefined;
    if (d) denials.push(...d);
  }
  if (signal.type === "tool_call") {
    const p = signal.payload as Record<string, unknown>;
    const tool = p.tool as string;
    const input = p.input as Record<string, unknown>;
    const cmd = tool === "Bash" ? String(input?.command ?? "").slice(0, 60) : "";
    console.log(`  ${DIM}tool_call: ${tool}${cmd ? ` → ${cmd}` : ""}${RESET}`);
  }
  if (signal.type === "tool_result") {
    const p = signal.payload as Record<string, unknown>;
    const err = p.isError;
    console.log(`  ${err ? RED + "✗ denied/error" : GREEN + "✓ approved"}${RESET}`);
  }
});

const prompt = `You are a test agent. Run ONLY Bash commands — one at a time. For each command, just run it and move on. Do not use Read, Write, Edit, or any other tool.

Commands to run (one per tool call):
1. ls /tmp
2. mkdir -p /tmp/expo-sandbox-test
3. cat /etc/hostname
4. touch /tmp/expo-sandbox-test/file.txt
5. sed 's/a/b/' <<< "abc"
6. awk 'BEGIN{print "hello"}'
7. find /tmp -name "expo-sandbox-test" -maxdepth 1
8. chmod 644 /tmp/expo-sandbox-test/file.txt
9. mv /tmp/expo-sandbox-test/file.txt /tmp/expo-sandbox-test/moved.txt
10. cp /tmp/expo-sandbox-test/moved.txt /tmp/expo-sandbox-test/copy.txt
11. python3 --version
12. node --version
13. git status
14. git log --oneline -1
15. curl -s httpbin.org/get | head -5
16. jq --version
17. rm /tmp/expo-sandbox-test/copy.txt
18. sudo ls /tmp
19. echo "done"

After running all, say DONE.`;

console.log(`${BOLD}Testing: research sandbox${RESET}`);
console.log(`  Preset allows: mkdir, ls, cat, head, curl, jq`);
console.log(`  Preset denies: git, gh, sudo`);
console.log(`  Everything else: should prompt (= denied headless)`);
console.log("");

const agent = await spawner.spawn({
  prompt,
  name: "sandbox-test",
  worktree: false,
  sandbox: SANDBOX_PRESETS["research"],
});

const result = await withTimeout(agent.process, agent.done, { timeoutMs: 180_000 });

console.log("");
console.log(`${BOLD}Exit${RESET}: code ${result.exitCode}${result.timedOut ? " (timed out)" : ""}`);
console.log("");

if (denials.length > 0) {
  console.log(`${YELLOW}Permission denials captured (${denials.length}):${RESET}`);
  for (const d of denials) {
    console.log(`  ${RED}✗${RESET} ${d}`);
  }
} else {
  console.log(`${DIM}No permission denials captured in result event.${RESET}`);
}

await bus.close();
// Cleanup
rm("/tmp/expo-sandbox-test").catch(() => {});
async function rm(p: string) { await Deno.remove(p, { recursive: true }); }
