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

    return await serveStatic(url.pathname);
  });
}
