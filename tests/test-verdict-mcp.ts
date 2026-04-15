/**
 * Regression tests for the refine verdict MCP server + inbox reader.
 *
 * Covers:
 *   1. Server responds to `initialize`, `tools/list`, `tools/call` over stdio JSON-RPC.
 *   2. A valid `submit_verdict` call writes the inbox file; the agent sees ok:true.
 *   3. Validation errors (missing fields, bad action, empty strings) return isError:true
 *      content without writing the inbox.
 *   4. readVerdictInbox is forgiving: returns null on missing, malformed JSON,
 *      invalid action, and missing required fields.
 *   5. writeRefineMcpConfig produces a config with the expo_refine server
 *      block wired to the correct inbox path.
 *   6. writeRefineMcpConfig merges an existing MCP config (e.g. auto-approve)
 *      and keeps both servers in the output.
 *
 * Run:  deno test --allow-all tests/test-verdict-mcp.ts
 */

import { join } from "https://deno.land/std/path/mod.ts";
import {
  buildRefineMcpServerBlock,
  inboxPathForIteration,
  mcpConfigPathForIteration,
  readVerdictInbox,
  writeRefineMcpConfig,
} from "../src/verdict-inbox.ts";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, predicate: boolean, detail?: string): void {
  if (predicate) {
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
    passed++;
  } else {
    console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ""}`);
    failed++;
    failures.push(name);
  }
}

// ── Subprocess helper ──────────────────────────────────────────

const SERVER_PATH = new URL("../src/refine-mcp-server.ts", import.meta.url).pathname;

interface RpcClient {
  send(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

/** Spawn the MCP server as a subprocess with the given EXPO_VERDICT_INBOX
 *  env var and return a JSON-RPC client that talks to it over stdio. */
async function spawnServer(inboxPath: string | undefined): Promise<RpcClient> {
  const env: Record<string, string> = {};
  if (inboxPath) env.EXPO_VERDICT_INBOX = inboxPath;

  const cmd = new Deno.Command("deno", {
    args: ["run", "--allow-all", SERVER_PATH],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
    env,
  });
  const proc = cmd.spawn();

  const writer = proc.stdin.getWriter();
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  // Line-buffered reader over stdout. Queue of pending waiters stays
  // FIFO — every request sent awaits one response line.
  let stdoutBuf = "";
  const pendingLines: string[] = [];
  const waiters: Array<(line: string) => void> = [];

  (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        stdoutBuf += decoder.decode(value);
        const parts = stdoutBuf.split("\n");
        stdoutBuf = parts.pop() ?? "";
        for (const line of parts) {
          if (!line.trim()) continue;
          const resolver = waiters.shift();
          if (resolver) {
            resolver(line);
          } else {
            pendingLines.push(line);
          }
        }
      }
    } catch {
      /* subprocess closed */
    }
  })();

  function nextLine(): Promise<string> {
    return new Promise((resolve) => {
      const queued = pendingLines.shift();
      if (queued !== undefined) {
        resolve(queued);
      } else {
        waiters.push(resolve);
      }
    });
  }

  let nextId = 1;

  return {
    async send(method, params) {
      const id = nextId++;
      const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
      await writer.write(encoder.encode(msg));
      // The server responds to requests but not notifications. Callers
      // pass the method as the way to distinguish — we rely on id match.
      const line = await nextLine();
      return JSON.parse(line) as Record<string, unknown>;
    },
    async close() {
      try {
        writer.releaseLock();
      } catch { /* already */ }
      try {
        proc.stdin.close();
      } catch { /* already */ }
      try {
        reader.releaseLock();
      } catch { /* already */ }
      try {
        proc.kill("SIGTERM");
      } catch { /* already */ }
      await proc.status;
    },
  };
}

// ── Test 1: initialize handshake ───────────────────────────────

console.log("\nrefine-mcp-server: initialize handshake:");
{
  const tmpDir = await Deno.makeTempDir({ prefix: "refine-mcp-test-" });
  const inboxPath = join(tmpDir, "verdict.json");
  const client = await spawnServer(inboxPath);
  try {
    const resp = await client.send("initialize", {});
    const result = resp.result as Record<string, unknown>;
    check("initialize returns a result", result !== undefined);
    check(
      "serverInfo.name is expo_refine",
      (result?.serverInfo as Record<string, unknown>)?.name === "expo_refine",
    );
    check(
      "advertises tools capability",
      !!(result?.capabilities as Record<string, unknown>)?.tools,
    );
  } finally {
    await client.close();
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
}

// ── Test 2: tools/list returns submit_verdict ──────────────────

console.log("\nrefine-mcp-server: tools/list advertises submit_verdict:");
{
  const tmpDir = await Deno.makeTempDir({ prefix: "refine-mcp-test-" });
  const inboxPath = join(tmpDir, "verdict.json");
  const client = await spawnServer(inboxPath);
  try {
    await client.send("initialize", {});
    const resp = await client.send("tools/list", {});
    const result = resp.result as { tools?: Array<Record<string, unknown>> };
    const tools = result?.tools ?? [];
    check("exactly one tool advertised", tools.length === 1);
    check("tool name is submit_verdict", tools[0]?.name === "submit_verdict");
    const schema = tools[0]?.inputSchema as Record<string, unknown>;
    check(
      "schema requires action + change + summary",
      Array.isArray(schema?.required) &&
        (schema.required as string[]).includes("action") &&
        (schema.required as string[]).includes("change") &&
        (schema.required as string[]).includes("summary"),
    );
  } finally {
    await client.close();
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
}

// ── Test 3: valid submit_verdict writes the inbox ──────────────

console.log("\nrefine-mcp-server: valid submit_verdict writes inbox file:");
{
  const tmpDir = await Deno.makeTempDir({ prefix: "refine-mcp-test-" });
  const inboxPath = join(tmpDir, "verdict.json");
  const client = await spawnServer(inboxPath);
  try {
    await client.send("initialize", {});
    const resp = await client.send("tools/call", {
      name: "submit_verdict",
      arguments: {
        action: "keep",
        change: "refactored auth to async/await",
        summary: "cleaner code, same behavior, all tests pass",
      },
    });
    const result = resp.result as Record<string, unknown>;
    check("tools/call returned a result", result !== undefined);
    check("not marked isError", !result.isError);
    const content = (result.content as Array<Record<string, unknown>>) ?? [];
    check("content has one block", content.length === 1);
    const payload = JSON.parse(content[0]?.text as string) as Record<string, unknown>;
    check("payload.ok is true", payload.ok === true);
    check("payload.action is keep", payload.action === "keep");

    // Verify the file actually landed on disk
    const inboxRaw = await Deno.readTextFile(inboxPath);
    const inbox = JSON.parse(inboxRaw);
    check("inbox file has action=keep", inbox.action === "keep");
    check("inbox file has change", typeof inbox.change === "string" && inbox.change.length > 0);
    check("inbox file has summary", typeof inbox.summary === "string" && inbox.summary.length > 0);
    check("inbox file has submitted_at", typeof inbox.submitted_at === "string");
    check("inbox file has empty gate_proposals by default", Array.isArray(inbox.gate_proposals) && inbox.gate_proposals.length === 0);
  } finally {
    await client.close();
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
}

// ── Test 4: validation — bad action ────────────────────────────

console.log("\nrefine-mcp-server: invalid action returns isError without writing:");
{
  const tmpDir = await Deno.makeTempDir({ prefix: "refine-mcp-test-" });
  const inboxPath = join(tmpDir, "verdict.json");
  const client = await spawnServer(inboxPath);
  try {
    await client.send("initialize", {});
    const resp = await client.send("tools/call", {
      name: "submit_verdict",
      arguments: {
        action: "maybe", // invalid
        change: "did stuff",
        summary: "things happened",
      },
    });
    const result = resp.result as Record<string, unknown>;
    check("isError is true", result.isError === true);
    const payload = JSON.parse(
      (result.content as Array<Record<string, unknown>>)[0].text as string,
    ) as Record<string, unknown>;
    check("payload.ok is false", payload.ok === false);
    check(
      "error mentions keep/discard/converged",
      typeof payload.error === "string" &&
        (payload.error as string).includes("keep") &&
        (payload.error as string).includes("discard") &&
        (payload.error as string).includes("converged"),
    );

    // Verify the file did NOT land
    const exists = await Deno.stat(inboxPath).then(() => true).catch(() => false);
    check("inbox file not created on validation failure", !exists);
  } finally {
    await client.close();
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
}

// ── Test 5: validation — empty change ──────────────────────────

console.log("\nrefine-mcp-server: empty change string is rejected:");
{
  const tmpDir = await Deno.makeTempDir({ prefix: "refine-mcp-test-" });
  const inboxPath = join(tmpDir, "verdict.json");
  const client = await spawnServer(inboxPath);
  try {
    await client.send("initialize", {});
    const resp = await client.send("tools/call", {
      name: "submit_verdict",
      arguments: { action: "keep", change: "   ", summary: "ok" },
    });
    const result = resp.result as Record<string, unknown>;
    check("isError is true on empty change", result.isError === true);
    const payload = JSON.parse(
      (result.content as Array<Record<string, unknown>>)[0].text as string,
    ) as Record<string, unknown>;
    check(
      "error mentions change must be non-empty",
      typeof payload.error === "string" && (payload.error as string).includes("change"),
    );
  } finally {
    await client.close();
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
}

// ── Test 6: gate_proposals shape ───────────────────────────────

console.log("\nrefine-mcp-server: well-formed gate_proposals pass through to inbox:");
{
  const tmpDir = await Deno.makeTempDir({ prefix: "refine-mcp-test-" });
  const inboxPath = join(tmpDir, "verdict.json");
  const client = await spawnServer(inboxPath);
  try {
    await client.send("initialize", {});
    const resp = await client.send("tools/call", {
      name: "submit_verdict",
      arguments: {
        action: "keep",
        change: "added auth tests",
        summary: "covers refresh + rotate",
        gate_proposals: [
          { name: "auth_tests", command: "deno test tests/auth/", rationale: "easy to regress" },
          { name: "types", command: "deno check --all" },
        ],
      },
    });
    const result = resp.result as Record<string, unknown>;
    check("not isError", !result.isError);
    const inbox = JSON.parse(await Deno.readTextFile(inboxPath));
    check("two proposals in inbox", inbox.gate_proposals.length === 2);
    check("first proposal has rationale", inbox.gate_proposals[0].rationale === "easy to regress");
    check("second proposal has no rationale field", inbox.gate_proposals[1].rationale === undefined);
  } finally {
    await client.close();
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
}

// ── Test 7: missing EXPO_VERDICT_INBOX env → write failure ─────

console.log("\nrefine-mcp-server: missing EXPO_VERDICT_INBOX env → write failure:");
{
  const client = await spawnServer(undefined);
  try {
    await client.send("initialize", {});
    const resp = await client.send("tools/call", {
      name: "submit_verdict",
      arguments: { action: "keep", change: "x", summary: "y" },
    });
    const result = resp.result as Record<string, unknown>;
    check("isError is true when env is missing", result.isError === true);
    const payload = JSON.parse(
      (result.content as Array<Record<string, unknown>>)[0].text as string,
    ) as Record<string, unknown>;
    check(
      "error mentions EXPO_VERDICT_INBOX",
      typeof payload.error === "string" &&
        (payload.error as string).includes("EXPO_VERDICT_INBOX"),
    );
  } finally {
    await client.close();
  }
}

// ── Test 8: readVerdictInbox — happy path ──────────────────────

console.log("\nreadVerdictInbox: well-formed file returns ParsedVerdict shape:");
{
  const tmpDir = await Deno.makeTempDir({ prefix: "refine-inbox-test-" });
  const inboxPath = join(tmpDir, "verdict.json");
  try {
    await Deno.writeTextFile(
      inboxPath,
      JSON.stringify({
        action: "keep",
        change: "did a thing",
        summary: "explanation of thing",
        gate_proposals: [
          { name: "g1", command: "echo ok" },
        ],
        submitted_at: new Date().toISOString(),
      }),
    );
    const v = await readVerdictInbox(inboxPath);
    check("returns non-null", v !== null);
    check("action is keep", v?.action === "keep");
    check("change matches", v?.change === "did a thing");
    check("one gate proposal parsed", v?.gateProposals.length === 1);
    check("gate name parsed", v?.gateProposals[0]?.name === "g1");
  } finally {
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
}

// ── Test 9: readVerdictInbox — missing file returns null ──────

console.log("\nreadVerdictInbox: missing file returns null (not error):");
{
  const tmpDir = await Deno.makeTempDir({ prefix: "refine-inbox-test-" });
  try {
    const v = await readVerdictInbox(join(tmpDir, "does-not-exist.json"));
    check("returns null on missing", v === null);
  } finally {
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
}

// ── Test 10: readVerdictInbox — malformed JSON returns null ───

console.log("\nreadVerdictInbox: malformed JSON returns null:");
{
  const tmpDir = await Deno.makeTempDir({ prefix: "refine-inbox-test-" });
  const inboxPath = join(tmpDir, "verdict.json");
  try {
    await Deno.writeTextFile(inboxPath, "{ not json");
    const v = await readVerdictInbox(inboxPath);
    check("returns null on malformed JSON", v === null);
  } finally {
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
}

// ── Test 11: readVerdictInbox — invalid action returns null ───

console.log("\nreadVerdictInbox: invalid action returns null:");
{
  const tmpDir = await Deno.makeTempDir({ prefix: "refine-inbox-test-" });
  const inboxPath = join(tmpDir, "verdict.json");
  try {
    await Deno.writeTextFile(
      inboxPath,
      JSON.stringify({
        action: "maybe",
        change: "x",
        summary: "y",
        gate_proposals: [],
        submitted_at: new Date().toISOString(),
      }),
    );
    const v = await readVerdictInbox(inboxPath);
    check("returns null on invalid action", v === null);
  } finally {
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
}

// ── Test 12: readVerdictInbox — missing change returns null ───

console.log("\nreadVerdictInbox: missing change returns null:");
{
  const tmpDir = await Deno.makeTempDir({ prefix: "refine-inbox-test-" });
  const inboxPath = join(tmpDir, "verdict.json");
  try {
    await Deno.writeTextFile(
      inboxPath,
      JSON.stringify({
        action: "keep",
        summary: "y",
        gate_proposals: [],
        submitted_at: new Date().toISOString(),
      }),
    );
    const v = await readVerdictInbox(inboxPath);
    check("returns null on missing change", v === null);
  } finally {
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
}

// ── Test 13: readVerdictInbox — drops malformed gate_proposals entries ─

console.log("\nreadVerdictInbox: malformed gate_proposals entries are silently dropped:");
{
  const tmpDir = await Deno.makeTempDir({ prefix: "refine-inbox-test-" });
  const inboxPath = join(tmpDir, "verdict.json");
  try {
    await Deno.writeTextFile(
      inboxPath,
      JSON.stringify({
        action: "keep",
        change: "x",
        summary: "y",
        gate_proposals: [
          { name: "good", command: "echo ok" },
          { name: "bad-no-cmd" }, // missing command
          null,
          "also not an object",
          { name: "", command: "echo" }, // empty name
        ],
        submitted_at: new Date().toISOString(),
      }),
    );
    const v = await readVerdictInbox(inboxPath);
    check("still returns non-null (action/change/summary valid)", v !== null);
    check("only one valid proposal survives", v?.gateProposals.length === 1);
    check("the valid one is 'good'", v?.gateProposals[0]?.name === "good");
  } finally {
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
}

// ── Test 14: writeRefineMcpConfig — produces correct shape ────

console.log("\nwriteRefineMcpConfig: produces expo_refine server block with inbox env:");
{
  const tmpDir = await Deno.makeTempDir({ prefix: "refine-mcp-config-test-" });
  const outPath = join(tmpDir, "mcp.json");
  const inboxPath = join(tmpDir, "verdict.json");
  try {
    const result = await writeRefineMcpConfig(outPath, inboxPath);
    check("returns outPath for chaining", result === outPath);
    const cfg = JSON.parse(await Deno.readTextFile(outPath));
    check("has mcpServers root", cfg.mcpServers !== undefined);
    check("has expo_refine server", cfg.mcpServers?.expo_refine !== undefined);
    // Command shape depends on whether we're running from source (deno) or
    // compiled (the expo binary). Assert it's an absolute path that exists;
    // that's the real invariant we care about.
    const cmd = cfg.mcpServers?.expo_refine?.command as string;
    check("expo_refine command is an absolute path", typeof cmd === "string" && cmd.startsWith("/"));
    check(
      "EXPO_VERDICT_INBOX env is set to inbox path",
      cfg.mcpServers?.expo_refine?.env?.EXPO_VERDICT_INBOX === inboxPath,
    );
    // If running under deno, args must be `run --allow-all <script>`. If
    // running under a compiled binary, args is `["__refine-mcp-server"]`.
    // Either way, args should be a non-empty array.
    check(
      "args is a non-empty array",
      Array.isArray(cfg.mcpServers?.expo_refine?.args) &&
        cfg.mcpServers.expo_refine.args.length > 0,
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
}

// ── Test 15: writeRefineMcpConfig — merges existing config ────

console.log("\nwriteRefineMcpConfig: merges with an existing MCP config (auto-approve case):");
{
  const tmpDir = await Deno.makeTempDir({ prefix: "refine-mcp-merge-test-" });
  const basePath = join(tmpDir, "auto-approve.json");
  const outPath = join(tmpDir, "merged.json");
  const inboxPath = join(tmpDir, "verdict.json");
  try {
    // Simulate an existing MCP config with an auto-approve server block
    await Deno.writeTextFile(
      basePath,
      JSON.stringify({
        mcpServers: {
          auto_approve: {
            command: "deno",
            args: ["run", "--allow-all", "/path/to/permission-mcp-server.ts"],
          },
        },
      }),
    );
    await writeRefineMcpConfig(outPath, inboxPath, basePath);
    const cfg = JSON.parse(await Deno.readTextFile(outPath));
    check("auto_approve server preserved", cfg.mcpServers?.auto_approve !== undefined);
    check("expo_refine server added", cfg.mcpServers?.expo_refine !== undefined);
    check(
      "both coexist",
      Object.keys(cfg.mcpServers ?? {}).length === 2,
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
}

// ── Test 16: writeRefineMcpConfig — missing base file doesn't kill it ─

console.log("\nwriteRefineMcpConfig: missing base config path is tolerated (warning, not error):");
{
  const tmpDir = await Deno.makeTempDir({ prefix: "refine-mcp-merge-test-" });
  const outPath = join(tmpDir, "merged.json");
  const inboxPath = join(tmpDir, "verdict.json");
  try {
    // Point at a file that doesn't exist
    await writeRefineMcpConfig(outPath, inboxPath, join(tmpDir, "nonexistent.json"));
    const cfg = JSON.parse(await Deno.readTextFile(outPath));
    check(
      "falls back to refine-mcp-only config",
      cfg.mcpServers?.expo_refine !== undefined &&
        Object.keys(cfg.mcpServers ?? {}).length === 1,
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
}

// ── Test 17: path helpers produce expected shapes ─────────────

console.log("\npath helpers: inboxPathForIteration + mcpConfigPathForIteration:");
{
  const dir = "/tmp/some-project";
  check(
    "inbox path under .refine/inbox/",
    inboxPathForIteration(dir, 3) === "/tmp/some-project/.refine/inbox/verdict-iter-3.json",
  );
  check(
    "config path under .refine/inbox/",
    mcpConfigPathForIteration(dir, 3) === "/tmp/some-project/.refine/inbox/mcp-config-iter-3.json",
  );
  const block = buildRefineMcpServerBlock("/tmp/inbox.json");
  // Command depends on runtime (source = deno, compiled = expo binary).
  // We just care that it's an absolute path so MCP spawn can find it.
  check(
    "block.command is an absolute path",
    typeof block.command === "string" && (block.command as string).startsWith("/"),
  );
  check(
    "block.env.EXPO_VERDICT_INBOX is set",
    (block.env as Record<string, string>)?.EXPO_VERDICT_INBOX === "/tmp/inbox.json",
  );
}

// ── Summary ───────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("\nFailures:");
  for (const name of failures) console.log(`  - ${name}`);
  Deno.exit(1);
}
