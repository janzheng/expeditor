/**
 * Signal Bus — Multiplexer
 *
 * Aggregates signals from multiple agent adapters into a single stream.
 * Consumers subscribe to the bus or read the JSONL output.
 */

import type { AgentSignal } from "./types.ts";

export type BusConsumer = (signal: AgentSignal) => void;

/** Default max log file size: 50MB */
const DEFAULT_MAX_LOG_BYTES = 50 * 1024 * 1024;

export interface BusOptions {
  logFile?: string;
  /** Max log file size in bytes before rotation (default: 50MB) */
  maxLogBytes?: number;
}

export class SignalBus {
  private consumers: Set<BusConsumer> = new Set();
  private logFile: string | null = null;
  private logHandle: Deno.FsFile | null = null;
  private logBytes = 0;
  private maxLogBytes: number;
  private encoder = new TextEncoder();

  constructor(opts?: BusOptions) {
    this.logFile = opts?.logFile ?? null;
    this.maxLogBytes = opts?.maxLogBytes ?? DEFAULT_MAX_LOG_BYTES;
  }

  /** Open log file for appending (call once at startup) */
  async init(): Promise<void> {
    if (this.logFile) {
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
      try {
        // Strip _raw from logged signals to save space (it's the full original event)
        const loggable = { ...signal };
        delete loggable._raw;
        const line = JSON.stringify(loggable) + "\n";
        const bytes = this.encoder.encode(line);

        await this.logHandle.write(bytes);
        this.logBytes += bytes.byteLength;

        // Rotate if over limit
        if (this.logBytes > this.maxLogBytes) {
          await this.rotate();
        }
      } catch (err) {
        // Log write failed (disk full, permissions, etc.) — don't crash the bus
        console.error(`[bus] log write error:`, String(err).slice(0, 200));
      }
    }
  }

  /** Rotate the log file — rename current to .1, start fresh */
  private async rotate(): Promise<void> {
    if (!this.logFile || !this.logHandle) return;

    try {
      this.logHandle.close();

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
      console.error(`[bus] rotation failed:`, String(err).slice(0, 200));
      // Try to reopen the original file
      try {
        this.logHandle = await Deno.open(this.logFile, {
          write: true,
          create: true,
          append: true,
        });
      } catch {
        this.logHandle = null;
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

  return new ReadableStream<string>({
    async start(controller) {
      const reader = readable.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            if (buffer.trim()) {
              controller.enqueue(buffer.trim());
            }
            controller.close();
            break;
          }
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (line.trim()) {
              controller.enqueue(line.trim());
            }
          }
        }
      } catch (err) {
        // Stream broke (process crashed, pipe closed, etc.)
        // Flush what we have and close cleanly
        if (buffer.trim()) {
          try { controller.enqueue(buffer.trim()); } catch { /* controller may be closed */ }
        }
        try { controller.close(); } catch { /* already closed */ }
        console.error(`[lineStream] stream error:`, String(err).slice(0, 200));
      } finally {
        reader.releaseLock();
      }
    },
  });
}
