/**
 * Expeditor Signal Bus — Multiplexer
 *
 * Aggregates signals from multiple agent adapters into a single stream.
 * Consumers subscribe to the bus or read the JSONL output.
 */

import type { AgentSignal } from "./types.ts";

export type BusConsumer = (signal: AgentSignal) => void;

/** Default max log file size: 50MB */
const DEFAULT_MAX_LOG_BYTES = 50 * 1024 * 1024;

/** Default cap on in-memory queue of writes deferred during rotation */
const DEFAULT_MAX_PENDING_WRITES = 10_000;

export interface BusOptions {
  logFile?: string;
  /** Max log file size in bytes before rotation (default: 50MB) */
  maxLogBytes?: number;
  /** Max deferred writes queued during rotation; oldest dropped when full (default: 10000) */
  maxPendingWrites?: number;
}

/**
 * Push `item` onto `queue`, dropping oldest entries if the queue would exceed `cap`.
 * Returns the number of entries dropped (0 when no cap pressure).
 *
 * Exported so the audit-scoped invariant (bus pendingWrites never grows unbounded
 * during a stalled rotation) can be regression-tested without spinning up a real bus.
 */
export function enqueueBounded<T>(queue: T[], item: T, cap: number): number {
  queue.push(item);
  let dropped = 0;
  while (queue.length > cap) {
    queue.shift();
    dropped++;
  }
  return dropped;
}

export class SignalBus {
  private consumers: Set<BusConsumer> = new Set();
  private logFile: string | null = null;
  private logHandle: Deno.FsFile | null = null;
  private logBytes = 0;
  private maxLogBytes: number;
  private maxPendingWrites: number;
  private encoder = new TextEncoder();
  private rotating = false;
  private pendingWrites: AgentSignal[] = [];
  private droppedDuringRotation = 0;

  constructor(opts?: BusOptions) {
    this.logFile = opts?.logFile ?? null;
    this.maxLogBytes = opts?.maxLogBytes ?? DEFAULT_MAX_LOG_BYTES;
    this.maxPendingWrites = opts?.maxPendingWrites ?? DEFAULT_MAX_PENDING_WRITES;
  }

  /** Open log file for appending (call once at startup) */
  async init(): Promise<void> {
    if (this.logFile) {
      // BUS-04: Close existing handle before re-init to prevent leak
      if (this.logHandle) {
        try { this.logHandle.close(); } catch { /* already closed */ }
        this.logHandle = null;
      }

      this.logHandle = await Deno.open(this.logFile, {
        write: true,
        create: true,
        append: true,
      });
      // Get current size for rotation tracking
      try {
        const stat = await Deno.stat(this.logFile);
        this.logBytes = stat.size;
      } catch {
        this.logBytes = 0;
      }
    }
  }

  /** Subscribe to all signals on the bus */
  subscribe(consumer: BusConsumer): () => void {
    this.consumers.add(consumer);
    return () => this.consumers.delete(consumer);
  }

  /** Emit a signal to all consumers and the log file */
  async emit(signal: AgentSignal): Promise<void> {
    // Notify all consumers — each in its own try/catch so one bad consumer doesn't break others
    for (const consumer of this.consumers) {
      try {
        consumer(signal);
      } catch (err) {
        console.error(`[bus] consumer error:`, String(err).slice(0, 200));
      }
    }

    // Append to log file — with write protection and rotation
    if (this.logHandle && this.logFile) {
      // BUS-02: Queue writes while rotating instead of dropping them.
      // Cap the queue so a stalled rotation (slow network FS, fallback loop) can't
      // grow memory linearly with signal rate — drop oldest; report once on flush.
      if (this.rotating) {
        this.droppedDuringRotation += enqueueBounded(
          this.pendingWrites,
          signal,
          this.maxPendingWrites,
        );
        return;
      }

      try {
        // Strip _raw from logged signals to save space (it's the full original event)
        const loggable = { ...signal };
        delete loggable._raw;
        const line = JSON.stringify(loggable) + "\n";
        const bytes = this.encoder.encode(line);

        // BUS-03: Check size BEFORE writing to enforce a hard cap
        if (this.logBytes + bytes.byteLength > this.maxLogBytes) {
          await this.rotate();
        }

        // After rotation, logHandle may be null if rotation failed fatally
        if (this.logHandle) {
          await this.logHandle.write(bytes);
          this.logBytes += bytes.byteLength;
        }
      } catch (err) {
        // Log write failed (disk full, permissions, etc.) — don't crash the bus
        console.error(`[bus] log write error:`, String(err).slice(0, 200));
      }
    }
  }

  /** Rotate the log file — rename current to .old, start fresh */
  private async rotate(): Promise<void> {
    if (!this.logFile || !this.logHandle) return;

    // BUS-02: Set rotating flag to prevent concurrent emit() from writing to closed handle
    this.rotating = true;
    const handle = this.logHandle;
    // BUS-02: Null out immediately so concurrent emit() sees no handle
    this.logHandle = null;

    try {
      handle.close();

      // Rename current → .old (overwrite any existing .old)
      const rotatedPath = this.logFile + ".old";
      try { await Deno.remove(rotatedPath); } catch { /* ok */ }
      await Deno.rename(this.logFile, rotatedPath);

      // Open fresh file
      this.logHandle = await Deno.open(this.logFile, {
        write: true,
        create: true,
        append: true,
      });
      this.logBytes = 0;

      console.error(`[bus] log rotated: ${this.logFile} → ${rotatedPath}`);
    } catch (err) {
      // BUS-01: On rotation failure, try harder to recover logging
      console.error(`[bus] rotation failed:`, String(err).slice(0, 200));

      // The rename may or may not have happened. Try to open the original path,
      // and if that fails, try a timestamped fallback so we don't lose signals.
      const fallbacks = [
        this.logFile,
        `${this.logFile}.${Date.now()}`,
      ];
      for (const path of fallbacks) {
        try {
          this.logHandle = await Deno.open(path, {
            write: true,
            create: true,
            append: true,
          });
          const stat = await Deno.stat(path);
          this.logBytes = stat.size;
          if (path !== this.logFile) {
            console.error(`[bus] logging to fallback: ${path}`);
          }
          break;
        } catch {
          // Try next fallback
        }
      }

      if (!this.logHandle) {
        console.error(`[bus] FATAL: cannot open any log file — signals will not be persisted`);
      }
    } finally {
      this.rotating = false;
      // Flush any signals that arrived during rotation
      const pending = this.pendingWrites.splice(0);
      for (const signal of pending) {
        if (this.logHandle) {
          const loggable = { ...signal };
          delete loggable._raw;
          const line = JSON.stringify(loggable) + "\n";
          const bytes = this.encoder.encode(line);
          try {
            await this.logHandle.write(bytes);
            this.logBytes += bytes.byteLength;
          } catch { /* best effort */ }
        }
      }
      // BUS-02: One consolidated warning if the cap dropped signals during this rotation.
      if (this.droppedDuringRotation > 0) {
        console.error(
          `[bus] dropped ${this.droppedDuringRotation} pending signal(s) during rotation (cap: ${this.maxPendingWrites})`,
        );
        this.droppedDuringRotation = 0;
      }
    }
  }

  /** Pipe a ReadableStream of lines through an adapter into the bus */
  async pipeLines(
    stream: ReadableStream<string>,
    adapter: (line: string) => AgentSignal[],
  ): Promise<void> {
    const reader = stream.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        let signals: AgentSignal[];
        try {
          signals = adapter(value);
        } catch (err) {
          console.error(`[bus] adapter error:`, String(err).slice(0, 200));
          continue; // skip bad lines, don't kill the pipe
        }

        for (const signal of signals) {
          await this.emit(signal);
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  /** Close the log file */
  async close(): Promise<void> {
    if (this.logHandle) {
      try {
        this.logHandle.close();
      } catch { /* already closed */ }
      this.logHandle = null;
    }
  }
}

/**
 * Convert a Deno.ChildProcess stdout into a ReadableStream of lines.
 * Handles broken pipes and unexpected stream termination gracefully.
 */
export function lineStream(
  readable: ReadableStream<Uint8Array>,
): ReadableStream<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  let reader: ReadableStreamDefaultReader<Uint8Array>;

  return new ReadableStream<string>({
    start() {
      reader = readable.getReader();
    },

    // BUS-05: Move read loop into pull() so the stream respects backpressure.
    // pull() is only called when the downstream consumer is ready for more data.
    async pull(controller) {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            if (buffer.trim()) {
              controller.enqueue(buffer.trim());
            }
            controller.close();
            reader.releaseLock();
            return;
          }
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          let enqueued = false;
          for (const line of lines) {
            if (line.trim()) {
              controller.enqueue(line.trim());
              enqueued = true;
            }
          }
          // If we enqueued at least one line, return to let the consumer
          // process it before we read more (backpressure).
          if (enqueued) return;
          // No complete lines yet — keep reading in the same pull() call.
        }
      } catch (err) {
        // BUS-06: On stream error, do NOT flush the buffer — it's likely a
        // partial/truncated line (e.g. half-written JSON). Flushing it would
        // emit invalid data that downstream JSON.parse would choke on.
        console.error(`[lineStream] stream error:`, String(err).slice(0, 200));
        try { controller.close(); } catch { /* already closed */ }
        reader.releaseLock();
      }
    },

    cancel() {
      try { reader.releaseLock(); } catch { /* reader may not be acquired yet */ }
    },
  });
}
