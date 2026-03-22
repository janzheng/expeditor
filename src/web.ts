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
}

export async function startServer(opts: ServeOptions): Promise<void> {
  const port = opts.port ?? 3000;
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
  console.log(`URL: http://localhost:${port}`);
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

  // HTTP server
  Deno.serve({ port }, async (req) => {
    const url = new URL(req.url);

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

    return await serveStatic(url.pathname);
  });
}

// --- API Handlers ---

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
  // Sanitize filename
  if (filename.includes("..") || filename.includes("/")) {
    return new Response("Bad request", { status: 400 });
  }
  try {
    const content = await Deno.readTextFile(`${logsDir}/${filename}`);
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
  const { PermissionLedger } = await import("./permission-ledger.ts");
  const ledger = new PermissionLedger();
  await ledger.load();
  return new Response(JSON.stringify(ledger.getAll()), { headers: JSON_HEADERS });
}

async function handleApprovePermission(pattern: string): Promise<Response> {
  if (!pattern) return new Response(JSON.stringify({ error: "pattern required" }), { status: 400, headers: JSON_HEADERS });
  const { PermissionLedger } = await import("./permission-ledger.ts");
  const ledger = new PermissionLedger();
  await ledger.load();
  ledger.approve(pattern);
  await ledger.save();
  return new Response(JSON.stringify({ ok: true, pattern, status: "approved" }), { headers: JSON_HEADERS });
}

async function handleRejectPermission(pattern: string): Promise<Response> {
  if (!pattern) return new Response(JSON.stringify({ error: "pattern required" }), { status: 400, headers: JSON_HEADERS });
  const { PermissionLedger } = await import("./permission-ledger.ts");
  const ledger = new PermissionLedger();
  await ledger.load();
  ledger.reject(pattern);
  await ledger.save();
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
