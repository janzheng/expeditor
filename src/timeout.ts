/**
 * Agent Timeout — Wraps a process's done promise with SIGTERM → grace → SIGKILL escalation
 *
 * Prevents indefinite hangs when an agent's process dies without cleanly closing stdout.
 *
 * Kill semantics: spawner prefers to launch agents under `setsid` so they're
 * the leader of their own session/process-group. On timeout we try to signal
 * the whole group (`kill -SIG -<pid>`) so forked children (git, rg, curl,
 * test runners) die with the parent instead of leaking. If group-kill fails
 * (no setsid available, or process already gone), we fall back to signaling
 * the leader PID alone.
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
 * Send a signal to the process group led by `pid`. Requires the process to
 * have been spawned under `setsid` (so PID == PGID). Returns true on
 * successful delivery, false on any failure (no-such-group, not-a-leader,
 * kill binary missing). Callers should fall back to per-PID signalling.
 */
function killProcessGroup(pid: number, signal: "TERM" | "KILL"): boolean {
  try {
    const out = new Deno.Command("kill", {
      args: [`-${signal}`, `-${pid}`], // negative pid = kill process group
      stdout: "null",
      stderr: "null",
    }).outputSync();
    return out.success;
  } catch {
    return false;
  }
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

    // Timeout fired — escalate. Try group-kill first so any forked
    // children (git, rg, test runners) also get the signal.
    console.warn(`[timeout] Process ${process.pid} timed out after ${timeoutMs}ms, sending SIGTERM`);
    if (!killProcessGroup(process.pid, "TERM")) {
      try {
        process.kill("SIGTERM");
      } catch {
        // Process already dead
      }
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

      // Grace period expired — SIGKILL. Same group-kill-first pattern.
      console.warn(`[timeout] Process ${process.pid} did not exit after SIGTERM, sending SIGKILL`);
      if (!killProcessGroup(process.pid, "KILL")) {
        try {
          process.kill("SIGKILL");
        } catch {
          // Process already dead
        }
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
