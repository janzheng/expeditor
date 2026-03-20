/**
 * Agent Timeout — Wraps a process's done promise with SIGTERM → grace → SIGKILL escalation
 *
 * Prevents indefinite hangs when an agent's process dies without cleanly closing stdout.
 */

export interface TimeoutOptions {
  /** Timeout in milliseconds. 0 or undefined = no timeout. */
  timeoutMs?: number;
  /** Grace period after SIGTERM before SIGKILL (default: 5000ms) */
  gracePeriodMs?: number;
}

export interface TimedResult {
  exitCode: number;
  timedOut: boolean;
}

/**
 * Race a process's `done` promise against a timeout.
 * On timeout: SIGTERM → grace period → SIGKILL.
 */
export async function withTimeout(
  process: Deno.ChildProcess,
  done: Promise<{ exitCode: number }>,
  opts: TimeoutOptions,
): Promise<TimedResult> {
  const timeoutMs = opts.timeoutMs;
  if (!timeoutMs || timeoutMs <= 0) {
    const result = await done;
    return { exitCode: result.exitCode, timedOut: false };
  }

  const gracePeriodMs = opts.gracePeriodMs ?? 5000;

  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });

  try {
    const raceResult = await Promise.race([
      done.then((r) => ({ kind: "done" as const, ...r })),
      timeoutPromise.then(() => ({ kind: "timeout" as const, exitCode: -1 })),
    ]);

    if (raceResult.kind === "done") {
      return { exitCode: raceResult.exitCode, timedOut: false };
    }

    // Timeout fired — escalate
    console.warn(`[timeout] Process ${process.pid} timed out after ${timeoutMs}ms, sending SIGTERM`);
    try {
      process.kill("SIGTERM");
    } catch {
      // Process already dead
    }

    // Wait for graceful shutdown or force kill
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const gracePromise = new Promise<"grace">((resolve) => {
      graceTimer = setTimeout(() => resolve("grace"), gracePeriodMs);
    });

    try {
      const graceResult = await Promise.race([
        done.then((r) => ({ kind: "done" as const, ...r })),
        gracePromise.then(() => ({ kind: "grace" as const, exitCode: -1 })),
      ]);

      if (graceResult.kind === "done") {
        return { exitCode: graceResult.exitCode, timedOut: true };
      }

      // Grace period expired — SIGKILL
      console.warn(`[timeout] Process ${process.pid} did not exit after SIGTERM, sending SIGKILL`);
      try {
        process.kill("SIGKILL");
      } catch {
        // Process already dead
      }

      // SIGKILL closes stdout fd → unblocks pipePromise → done resolves
      const finalResult = await done;
      return { exitCode: finalResult.exitCode, timedOut: true };
    } finally {
      clearTimeout(graceTimer);
    }
  } finally {
    clearTimeout(timer);
  }
}
