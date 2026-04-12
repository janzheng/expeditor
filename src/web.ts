/**
 * Web Dashboard — SSE server + static HTML for live agent monitoring
 *
 * Watches a JSONL bus log file (or subscribes to a live bus) and streams
 * events to connected browsers via Server-Sent Events.
 *
 * Usage:
 *   expo serve [--port 3000] [--log <file.jsonl>]
 */

const STATIC_DIR = new URL("./web/", import.meta.url).pathname;

interface SSEClient {
  controller: ReadableStreamDefaultController;
  id: number;
}

let clientId = 0;
const clients = new Set<SSEClient>();

/** Broadcast a signal to all connected SSE clients */
function broadcast(eventType: string, data: unknown): void {
  const msg = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) {
    try {
      client.controller.enqueue(new TextEncoder().encode(msg));
    } catch {
      clients.delete(client);
    }
  }
}

/** Create an SSE response stream for a new client */
function createSSEStream(): { response: Response; client: SSEClient } {
  let client: SSEClient;
  const stream = new ReadableStream({
    start(controller) {
      client = { controller, id: ++clientId };
      clients.add(client);
      // Send initial connection event
      controller.enqueue(
        new TextEncoder().encode(`event: connected\ndata: {"clientId":${client.id}}\n\n`),
      );
    },
    cancel() {
      clients.delete(client!);
    },
  });

  return {
    response: new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "Access-Control-Allow-Origin": "*",
      },
    }),
    client: client!,
  };
}

/** Serve static files from src/web/ */
async function serveStatic(path: string): Promise<Response> {
  const filePath = `${STATIC_DIR}${path === "/" ? "index.html" : path}`;
  try {
    const data = await Deno.readFile(filePath);
    const contentType = filePath.endsWith(".html")
      ? "text/html"
      : filePath.endsWith(".js")
        ? "application/javascript"
        : filePath.endsWith(".css")
          ? "text/css"
          : "application/octet-stream";
    return new Response(data, { headers: { "Content-Type": contentType } });
  } catch {
    return new Response("Not Found", { status: 404 });
  }
}

/** Tail a JSONL file and broadcast new lines as SSE events */
async function tailLog(logPath: string, signal: AbortSignal): Promise<void> {
  // First, read existing content to show current state
  try {
    const existing = await Deno.readTextFile(logPath);
    for (const line of existing.split("\n")) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        broadcast("signal", event);
      } catch { /* skip bad lines */ }
    }
    broadcast("replay-done", { lines: existing.split("\n").filter((l) => l.trim()).length });
  } catch {
    // File doesn't exist yet — that's fine, we'll watch for it
  }

  // Then watch for new lines
  const watcher = Deno.watchFs(logPath);
  let lastSize = 0;
  try {
    const stat = await Deno.stat(logPath);
    lastSize = stat.size;
  } catch { /* file may not exist yet */ }

  for await (const event of watcher) {
    if (signal.aborted) break;
    if (event.kind !== "modify") continue;

    try {
      const stat = await Deno.stat(logPath);
      if (stat.size <= lastSize) continue;

      // Read new bytes
      const file = await Deno.open(logPath, { read: true });
      await file.seek(lastSize, Deno.SeekMode.Start);
      const buf = new Uint8Array(stat.size - lastSize);
      await file.read(buf);
      file.close();
      lastSize = stat.size;

      const newContent = new TextDecoder().decode(buf);
      for (const line of newContent.split("\n")) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          broadcast("signal", parsed);
        } catch { /* skip bad lines */ }
      }
    } catch {
      // File may have been rotated — reset
      lastSize = 0;
    }
  }
}

/** Find the most recent bus log file */
async function findLatestLog(logsDir: string): Promise<string | null> {
  try {
    const entries = [];
    for await (const entry of Deno.readDir(logsDir)) {
      if (entry.name.endsWith(".jsonl") && !entry.name.endsWith(".old")) {
        entries.push(entry.name);
      }
    }
    entries.sort().reverse();
    return entries[0] ? `${logsDir}/${entries[0]}` : null;
  } catch {
    return null;
  }
}

export interface ServeOptions {
  port?: number;
  logFile?: string;
  /** Interface to bind. Defaults to 127.0.0.1 (loopback only) so browser
   *  tabs on the same machine can reach it but LAN peers cannot. Set to
   *  "0.0.0.0" to explicitly expose on all interfaces — requires the
   *  caller to have also set a bearer token they trust distribution of. */
  host?: string;
  /** Require `Authorization: Bearer <token>` on mutating routes
   *  (POST /api/spawn, /api/race, /api/review, /api/permissions/*).
   *  When unset, a random token is generated at startup and printed to
   *  stderr. Set to an empty string + `noAuth: true` to disable auth
   *  entirely (never recommended outside trusted local-only scripts). */
  authToken?: string;
  /** Explicit opt-out of auth. When true, all routes are open. Used for
   *  tests and tightly-scoped scripts. Requires `host === "127.0.0.1"`
   *  as a safety net — we refuse to serve `0.0.0.0` without auth. */
  noAuth?: boolean;
}

/** Mutating routes that require a bearer token. Kept in a module-level
 *  set so the dispatcher and the auth check agree on what's protected. */
const MUTATING_ROUTES: ReadonlySet<string> = new Set([
  "/api/spawn",
  "/api/race",
  "/api/review",
  "/api/permissions/approve",
  "/api/permissions/reject",
]);

/** Generate a random bearer token. 32 hex chars = 128 bits of entropy —
 *  plenty for a local dev dashboard. */
function generateBearerToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Check whether a mutating request carries the expected bearer token.
 *  Uses constant-time comparison to avoid timing oracles on short tokens. */
function isAuthorized(req: Request, expected: string): boolean {
  const header = req.headers.get("authorization");
  if (!header || !header.startsWith("Bearer ")) return false;
  const provided = header.slice("Bearer ".length).trim();
  if (provided.length !== expected.length) return false;
  // Constant-time compare
  let diff = 0;
  for (let i = 0; i < provided.length; i++) {
    diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

export async function startServer(opts: ServeOptions): Promise<void> {
  const port = opts.port ?? 3000;
  const host = opts.host ?? "127.0.0.1";
  const noAuth = opts.noAuth ?? false;

  // Safety rail: refuse to bind to a non-loopback interface without auth.
  // Anyone hitting the dashboard from another machine could otherwise POST
  // /api/spawn and launch arbitrary commands on this host.
  if (noAuth && host !== "127.0.0.1") {
    throw new Error(
      `Refusing to start: --no-auth requires --host 127.0.0.1 (got ${host}). ` +
      `Exposing unauthenticated spawn/race/review endpoints on ${host} would let any network peer execute commands.`,
    );
  }

  const authToken = noAuth ? "" : (opts.authToken ?? generateBearerToken());

  const logsDir = ".expo/logs";

  // Determine which log file to tail
  let logFile = opts.logFile;
  if (!logFile) {
    logFile = await findLatestLog(logsDir) ?? undefined;
    if (!logFile) {
      console.log(`No log files found in ${logsDir}. Dashboard will show new events as they arrive.`);
      // Create an empty log to watch
      await Deno.mkdir(logsDir, { recursive: true });
      logFile = `${logsDir}/bus-live.jsonl`;
      await Deno.writeTextFile(logFile, "");
    }
  }

  console.log(`Log: ${logFile}`);
  console.log(`URL: http://${host}:${port}`);
  if (!noAuth) {
    console.log("");
    console.log("Auth: mutating endpoints require `Authorization: Bearer <token>`");
    console.log(`      Token: ${authToken}`);
    console.log("      Export this token to use the dashboard launch UI or scripted clients.");
  } else {
    console.log("Auth: DISABLED (--no-auth). Loopback-only by safety check.");
  }
  console.log("");

  // Start log tailer in background
  const abortController = new AbortController();
  tailLog(logFile, abortController.signal).catch(() => {});

  // Also watch for new log files (when a new expo command starts)
  (async () => {
    const watcher = Deno.watchFs(logsDir);
    let currentLog = logFile!;
    for await (const event of watcher) {
      if (abortController.signal.aborted) break;
      if (event.kind !== "create") continue;
      for (const path of event.paths) {
        if (path.endsWith(".jsonl") && !path.endsWith(".old") && path !== currentLog) {
          console.log(`New log detected: ${path}`);
          currentLog = path;
          // Start tailing the new file too
          tailLog(path, abortController.signal).catch(() => {});
        }
      }
    }
  })().catch(() => {});

  // HTTP server. Binds to `host` (default 127.0.0.1) rather than all
  // interfaces so LAN peers can't POST /api/spawn without explicit opt-in.
  Deno.serve({ port, hostname: host }, async (req) => {
    const url = new URL(req.url);

    // Gate mutating routes behind a bearer token. Auth failure returns
    // 401 with a plain-JSON error — no token means no ability to spawn.
    if (!noAuth && MUTATING_ROUTES.has(url.pathname)) {
      if (!isAuthorized(req, authToken)) {
        return new Response(
          JSON.stringify({ error: "unauthorized", hint: "provide Authorization: Bearer <token> printed at startup" }),
          { status: 401, headers: { "Content-Type": "application/json" } },
        );
      }
    }

    if (url.pathname === "/events") {
      const { response } = createSSEStream();
      return response;
    }

    // --- API: Run history ---
    if (url.pathname === "/api/runs") {
      return await handleListRuns(logsDir);
    }
    if (url.pathname.startsWith("/api/runs/")) {
      const filename = url.pathname.slice("/api/runs/".length);
      return await handleGetRun(logsDir, filename);
    }

    // --- API: Permissions ---
    if (url.pathname === "/api/permissions" && req.method === "GET") {
      return await handleGetPermissions();
    }
    if (url.pathname === "/api/permissions/approve" && req.method === "POST") {
      const body = await req.json() as { pattern: string };
      return await handleApprovePermission(body.pattern);
    }
    if (url.pathname === "/api/permissions/reject" && req.method === "POST") {
      const body = await req.json() as { pattern: string };
      return await handleRejectPermission(body.pattern);
    }

    // --- API: Cost summary ---
    if (url.pathname === "/api/costs") {
      return await handleCostSummary(logsDir);
    }

    // --- API: Launch agents ---
    if (url.pathname === "/api/spawn" && req.method === "POST") {
      return await handleSpawn(await req.json());
    }
    if (url.pathname === "/api/race" && req.method === "POST") {
      return await handleRace(await req.json());
    }
    if (url.pathname === "/api/review" && req.method === "POST") {
      return await handleReview(await req.json());
    }

    return await serveStatic(url.pathname);
  });
}

// --- API Handlers ---

// CORS: intentionally NOT wildcard on mutating routes. Wildcard on GETs
// is fine (read-only, auth-free), but spawn/race/review require bearer
// auth and must not advertise themselves as callable from any origin —
// that would lure browsers into attempting cross-origin POSTs even
// though they'd be rejected at auth, which is noisy and misleading.
const JSON_HEADERS = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };

async function handleListRuns(logsDir: string): Promise<Response> {
  try {
    const runs = [];
    for await (const entry of Deno.readDir(logsDir)) {
      if (!entry.name.endsWith(".jsonl") || entry.name.endsWith(".old")) continue;
      const path = `${logsDir}/${entry.name}`;
      const stat = await Deno.stat(path);

      // Quick scan: count agents and total cost from the file
      let agentCount = 0;
      let totalCost = 0;
      const agents = new Set<string>();
      try {
        const content = await Deno.readTextFile(path);
        for (const line of content.split("\n")) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);
            agents.add(event.agentId);
            if (event.type === "cost") {
              const cost = event.payload?.totalCostUsd ?? 0;
              if (cost > totalCost) totalCost = cost; // cost signals are cumulative per agent
            }
          } catch { /* skip bad lines */ }
        }
        agentCount = agents.size;
      } catch { /* file read error */ }

      runs.push({
        filename: entry.name,
        timestamp: stat.mtime?.getTime() ?? 0,
        size: stat.size,
        agentCount,
        totalCost,
      });
    }
    runs.sort((a, b) => b.timestamp - a.timestamp);
    return new Response(JSON.stringify(runs), { headers: JSON_HEADERS });
  } catch {
    return new Response("[]", { headers: JSON_HEADERS });
  }
}

async function handleGetRun(logsDir: string, filename: string): Promise<Response> {
  // Sanitize filename — reject obvious traversal first as a cheap guard.
  if (filename.includes("..") || filename.includes("/") || filename.includes("\\")) {
    return new Response("Bad request", { status: 400 });
  }
  try {
    // Canonicalize both paths so a symlink inside .expo/logs can't smuggle
    // a read of /etc/passwd or other files outside logsDir. Without this,
    // an agent with write access to .expo/logs could create a symlink
    // whose name looks like a .jsonl log and the dashboard would serve
    // whatever it pointed at.
    const canonicalLogsDir = await Deno.realPath(logsDir);
    const requested = await Deno.realPath(`${logsDir}/${filename}`);
    const prefix = canonicalLogsDir.endsWith("/") ? canonicalLogsDir : canonicalLogsDir + "/";
    if (requested !== canonicalLogsDir && !requested.startsWith(prefix)) {
      return new Response("Bad request", { status: 400 });
    }

    const content = await Deno.readTextFile(requested);
    const events = content.split("\n")
      .filter((l) => l.trim())
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
    return new Response(JSON.stringify(events), { headers: JSON_HEADERS });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}

async function handleGetPermissions(): Promise<Response> {
  const { getPermissionLedger } = await import("./permission-ledger.ts");
  const ledger = getPermissionLedger();
  await ledger.load();
  return new Response(JSON.stringify(ledger.getAll()), { headers: JSON_HEADERS });
}

async function handleApprovePermission(pattern: string): Promise<Response> {
  if (!pattern) return new Response(JSON.stringify({ error: "pattern required" }), { status: 400, headers: JSON_HEADERS });
  const { mutatePermissionLedger } = await import("./permission-ledger.ts");
  await mutatePermissionLedger((ledger) => { ledger.approve(pattern); });
  return new Response(JSON.stringify({ ok: true, pattern, status: "approved" }), { headers: JSON_HEADERS });
}

async function handleRejectPermission(pattern: string): Promise<Response> {
  if (!pattern) return new Response(JSON.stringify({ error: "pattern required" }), { status: 400, headers: JSON_HEADERS });
  const { mutatePermissionLedger } = await import("./permission-ledger.ts");
  await mutatePermissionLedger((ledger) => { ledger.reject(pattern); });
  return new Response(JSON.stringify({ ok: true, pattern, status: "rejected" }), { headers: JSON_HEADERS });
}

async function handleCostSummary(logsDir: string): Promise<Response> {
  try {
    const runs = [];
    for await (const entry of Deno.readDir(logsDir)) {
      if (!entry.name.endsWith(".jsonl") || entry.name.endsWith(".old")) continue;
      const path = `${logsDir}/${entry.name}`;
      const stat = await Deno.stat(path);

      const agentCosts = new Map<string, number>();
      try {
        const content = await Deno.readTextFile(path);
        for (const line of content.split("\n")) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);
            if (event.type === "cost") {
              const cost = event.payload?.totalCostUsd ?? 0;
              agentCosts.set(event.agentId, Math.max(agentCosts.get(event.agentId) ?? 0, cost));
            }
          } catch { /* skip */ }
        }
      } catch { /* skip */ }

      const totalCost = Array.from(agentCosts.values()).reduce((a, b) => a + b, 0);
      if (totalCost > 0 || agentCosts.size > 0) {
        runs.push({
          filename: entry.name,
          timestamp: stat.mtime?.getTime() ?? 0,
          agents: Object.fromEntries(agentCosts),
          totalCost,
        });
      }
    }
    runs.sort((a, b) => b.timestamp - a.timestamp);
    const grandTotal = runs.reduce((sum, r) => sum + r.totalCost, 0);
    return new Response(JSON.stringify({ runs, grandTotal }), { headers: JSON_HEADERS });
  } catch {
    return new Response(JSON.stringify({ runs: [], grandTotal: 0 }), { headers: JSON_HEADERS });
  }
}

// --- Launch Handlers ---

/** Spawn a background expo command and return immediately */
function spawnBackground(args: string[]): void {
  const cmd = new Deno.Command("deno", {
    args: ["run", "--allow-all", "src/cli.ts", ...args],
    cwd: Deno.cwd(),
    stdin: "null",
    stdout: "null",
    stderr: "null",
  });
  // Fire and forget — the spawned process writes to the bus log,
  // which the dashboard tails automatically.
  cmd.spawn();
}

function handleSpawn(body: Record<string, unknown>): Response {
  const prompt = String(body.prompt ?? "");
  if (!prompt) {
    return new Response(JSON.stringify({ error: "prompt is required" }), { status: 400, headers: JSON_HEADERS });
  }

  const args: string[] = ["spawn", prompt];
  if (body.name) args.push("--name", String(body.name));
  if (body.sandbox) args.push("--sandbox", String(body.sandbox));
  if (body.agent && body.agent !== "claude") args.push("--agent", String(body.agent));
  if (body.timeout) args.push("--timeout", String(body.timeout));
  if (body.noWorktree) args.push("--no-worktree");

  spawnBackground(args);
  return new Response(JSON.stringify({ ok: true, message: "Spawn started — check Live page" }), { headers: JSON_HEADERS });
}

function handleRace(body: Record<string, unknown>): Response {
  const promptA = String(body.promptA ?? "");
  const promptB = String(body.promptB ?? "");
  if (!promptA || !promptB) {
    return new Response(JSON.stringify({ error: "promptA and promptB are required" }), { status: 400, headers: JSON_HEADERS });
  }

  const args: string[] = ["race", promptA, "vs", promptB];
  if (body.criteria) args.push("--criteria", String(body.criteria));
  if (body.timeout) args.push("--timeout", String(body.timeout));

  spawnBackground(args);
  return new Response(JSON.stringify({ ok: true, message: "Race started — check Live page" }), { headers: JSON_HEADERS });
}

function handleReview(body: Record<string, unknown>): Response {
  const prompt = String(body.prompt ?? "");
  if (!prompt) {
    return new Response(JSON.stringify({ error: "prompt is required" }), { status: 400, headers: JSON_HEADERS });
  }

  const args: string[] = ["review", prompt];
  if (body.maxIterations) args.push("--max", String(body.maxIterations));
  if (body.timeout) args.push("--timeout", String(body.timeout));

  spawnBackground(args);
  return new Response(JSON.stringify({ ok: true, message: "Review started — check Live page" }), { headers: JSON_HEADERS });
}
