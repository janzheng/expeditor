/**
 * ConcurrencyLimit — bounded fan-out primitive for agent orchestration.
 *
 * Problem: all four expo fan-out paths (race, workflow, mxit parallel,
 * spawn-all) used raw `Promise.allSettled(tasks.map(f))`, which runs
 * every task concurrently with no ceiling. A TASKS.md with 100 ready
 * items would spawn 100 Claude CLI processes simultaneously — ~10GB
 * RAM, 100 API connections, cost-guard-too-late budget bleed.
 *
 * This class implements a classic async semaphore: `run(fn)` awaits
 * until there's a free slot, executes fn, releases the slot. Other
 * waiters are woken FIFO.
 *
 * Usage:
 *
 *   const limit = new ConcurrencyLimit(5);
 *   const results = await Promise.allSettled(
 *     tasks.map((t) => limit.run(async () => {
 *       const agent = await spawner.spawn(buildOpts(t));
 *       return withTimeout(agent.process, agent.done, { timeoutMs });
 *     })),
 *   );
 *
 * Wrap the FULL lifecycle (spawn + wait), not just wait — otherwise
 * you pre-allocate worktrees, network connections, and file handles
 * for all N tasks before any of them finish, which is most of what
 * you were trying to avoid.
 */

/**
 * Default max concurrency for fan-outs. Matches the `/subagent` skill's
 * recommendation of 5 parallel subagents per round — a number that's
 * been load-tested in practice and doesn't overwhelm typical laptops
 * or hit Anthropic's per-org rate limits for small teams.
 */
export const DEFAULT_MAX_CONCURRENT = 5;

export class ConcurrencyLimit {
  #running = 0;
  #queue: Array<() => void> = [];

  constructor(public readonly max: number) {
    if (!Number.isFinite(max) || max < 1) {
      throw new Error(`ConcurrencyLimit max must be a positive integer (got ${max})`);
    }
    // Integer floor — fractional slots make no sense, surface the caller's error.
    this.max = Math.floor(max);
  }

  /** Number of tasks currently executing. Useful for tests and telemetry. */
  get running(): number {
    return this.#running;
  }

  /** Number of tasks waiting for a slot. Useful for tests and telemetry. */
  get queued(): number {
    return this.#queue.length;
  }

  /**
   * Execute `fn` under the semaphore. Acquires a slot (waiting if all
   * slots are occupied), runs fn to completion, releases the slot.
   *
   * The slot is released even if `fn` throws — the caller sees the
   * exception, the limit stays healthy for other waiters.
   */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.#acquire();
    try {
      return await fn();
    } finally {
      this.#release();
    }
  }

  /**
   * "Waiting-set" variant: release the CURRENT slot for the duration of
   * `fn`, then re-acquire before returning. MUST be called from inside
   * a `run()` — there must be a slot to release.
   *
   * The use case is hierarchical fan-out: a parent task that's holding
   * a slot wants to AWAIT nested work on the SAME semaphore (e.g. a
   * workflow stage spawning its own race). Without this, `max` slots
   * of parents all blocked on children would monopolize the pool and
   * their children would never run — textbook starvation.
   *
   * With runWaiting:
   *   - parent releases its slot ("moves to waiting set")
   *   - children run, possibly triggering more fan-out
   *   - parent re-acquires when its children resolve ("re-enters running")
   *
   * The slot is re-acquired even if `fn` throws — caller sees the
   * exception, the parent resumes holding a slot so its caller's
   * `run()` `finally` can release it cleanly.
   *
   * Flat fan-outs (race/workflow/mxit today) don't need this — each
   * task is a leaf spawn. The primitive exists for the moment expo grows
   * nested orchestration (e.g. workflow stages that invoke race), so the
   * deadlock doesn't have to be re-discovered the hard way.
   */
  async runWaiting<T>(fn: () => Promise<T>): Promise<T> {
    // Release the slot we're presumed to hold. A caller who invokes this
    // without holding a slot will underflow `running` — which is a bug
    // in their code, but we surface it clearly rather than silently
    // corrupting the counter.
    if (this.#running <= 0) {
      throw new Error(
        "ConcurrencyLimit.runWaiting called without holding a slot " +
          "(must be invoked from inside a run() callback)",
      );
    }
    this.#release();
    try {
      return await fn();
    } finally {
      // Re-acquire before returning — if all slots are full we wait in
      // the FIFO queue just like a fresh run() caller. This is correct:
      // a returning parent has no priority over freshly-submitted work.
      await this.#acquire();
    }
  }

  #acquire(): Promise<void> {
    if (this.#running < this.max) {
      this.#running++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      // We don't increment `running` here; the subsequent release()
      // will hand the slot to us by resolving the queued promise.
      this.#queue.push(resolve);
    });
  }

  #release(): void {
    const next = this.#queue.shift();
    if (next) {
      // Hand the slot off directly — `running` stays the same.
      next();
    } else {
      this.#running--;
    }
  }
}
