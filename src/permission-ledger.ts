/**
 * Permission Ledger — Persist denied permission patterns across runs
 *
 * Tracks what tools/patterns agents were denied access to. Users can approve
 * patterns so subsequent runs merge them into the sandbox config automatically.
 *
 * Follows the Registry pattern: JSON file, Map-based in-memory store, load/save.
 */

import type { SandboxConfig } from "./spawner.ts";
import type { DenialDetail } from "./types.ts";

export interface PermissionEntry {
  /** Tool/pattern string, e.g. "Bash(git push:*)", "Write", "mcp__slack__send" */
  pattern: string;
  /** Current status */
  status: "approved" | "rejected" | "pending";
  /** Epoch ms when first seen */
  firstSeen: number;
  /** Epoch ms when last seen */
  lastSeen: number;
  /** Number of times this denial was recorded */
  count: number;
  /** Which agent triggered it (last source) */
  source?: string;
  /** Recent examples of denied commands (last 3) */
  examples?: DenialExample[];
}

export interface DenialExample {
  /** Full command string, e.g. "git push origin main" */
  command?: string;
  /** Agent-provided description, e.g. "Push changes to remote" */
  description?: string;
  /** Which agent triggered this example */
  source?: string;
  /** When this example was recorded */
  timestamp: number;
}

const DEFAULT_LEDGER_PATH = ".expo/permissions.json";

export class PermissionLedger {
  private entries: Map<string, PermissionEntry> = new Map();
  private filePath: string;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(opts?: { filePath?: string; cwd?: string }) {
    const cwd = opts?.cwd ?? Deno.cwd();
    this.filePath = opts?.filePath ?? `${cwd}/${DEFAULT_LEDGER_PATH}`;
  }

  /** Load ledger from disk */
  async load(): Promise<void> {
    try {
      const data = await Deno.readTextFile(this.filePath);
      const entries: PermissionEntry[] = JSON.parse(data);
      this.entries.clear();
      for (const entry of entries) {
        this.entries.set(entry.pattern, entry);
      }
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) {
        this.entries.clear();
        return;
      }
      throw new Error(`Failed to load permission ledger at ${this.filePath}: ${err instanceof SyntaxError ? "corrupt JSON — delete the file or fix manually" : String(err)}`);
    }
  }

  /** Save ledger to disk — serialized via write queue to prevent concurrent corruption */
  async save(): Promise<void> {
    this.writeQueue = this.writeQueue.then(async () => {
      const dir = this.filePath.substring(0, this.filePath.lastIndexOf("/"));
      await Deno.mkdir(dir, { recursive: true });
      const data = JSON.stringify(Array.from(this.entries.values()), null, 2);
      await Deno.writeTextFile(this.filePath, data);
    }).catch((err) => {
      console.error(`[permission-ledger] save failed: ${String(err).slice(0, 200)}`);
    });
    await this.writeQueue;
  }

  /** Record one or more denial patterns from an agent run */
  recordDenials(denials: string[], source?: string, details?: DenialDetail[]): void {
    const now = Date.now();

    // Build a map from pattern → detail for quick lookup
    const detailMap = new Map<string, DenialDetail>();
    if (details) {
      for (const d of details) {
        detailMap.set(d.pattern, d);
      }
    }

    for (const pattern of denials) {
      const detail = detailMap.get(pattern);
      const example: DenialExample | undefined = detail?.command
        ? { command: detail.command, description: detail.description, source, timestamp: now }
        : undefined;

      const existing = this.entries.get(pattern);
      if (existing) {
        existing.count += 1;
        existing.lastSeen = now;
        if (source) existing.source = source;
        // Append example, keep last 3
        if (example) {
          existing.examples = [...(existing.examples ?? []), example].slice(-3);
        }
        // Don't overwrite approved/rejected status — only update pending entries
      } else {
        this.entries.set(pattern, {
          pattern,
          status: "pending",
          firstSeen: now,
          lastSeen: now,
          count: 1,
          source,
          examples: example ? [example] : undefined,
        });
      }
    }
  }

  /** Get all pending entries */
  getPending(): PermissionEntry[] {
    return this.getAll().filter((e) => e.status === "pending");
  }

  /** Get all entries */
  getAll(): PermissionEntry[] {
    return Array.from(this.entries.values());
  }

  /** Approve a pattern for future runs */
  approve(pattern: string): boolean {
    const entry = this.entries.get(pattern);
    if (entry) {
      entry.status = "approved";
      return true;
    }
    // Allow approving patterns not yet seen (pre-approve)
    this.entries.set(pattern, {
      pattern,
      status: "approved",
      firstSeen: Date.now(),
      lastSeen: Date.now(),
      count: 0,
    });
    return true;
  }

  /** Reject a pattern (add to deny list in future runs) */
  reject(pattern: string): boolean {
    const entry = this.entries.get(pattern);
    if (entry) {
      entry.status = "rejected";
      return true;
    }
    this.entries.set(pattern, {
      pattern,
      status: "rejected",
      firstSeen: Date.now(),
      lastSeen: Date.now(),
      count: 0,
    });
    return true;
  }

  /** Clear all entries */
  reset(): void {
    this.entries.clear();
  }

  /**
   * Merge approved/rejected patterns into a base sandbox config.
   * Approved patterns are added to `allow`, rejected to `deny`.
   * Returns a new SandboxConfig — does not mutate the input.
   */
  buildSandbox(base: SandboxConfig): SandboxConfig {
    const allow = [...(base.allow ?? [])];
    const deny = [...(base.deny ?? [])];

    for (const entry of this.entries.values()) {
      if (entry.status === "approved" && !allow.includes(entry.pattern)) {
        allow.push(entry.pattern);
      }
      if (entry.status === "rejected" && !deny.includes(entry.pattern)) {
        deny.push(entry.pattern);
      }
    }

    return {
      ...base,
      allow: allow.length > 0 ? allow : undefined,
      deny: deny.length > 0 ? deny : undefined,
    };
  }

  /**
   * Sync approved/rejected patterns to a Claude Code settings file.
   * Merges into `permissions.allow` and `permissions.deny` without duplicating.
   * Returns { added, skipped } counts.
   */
  async syncToSettings(settingsPath: string, opts?: { dryRun?: boolean }): Promise<{
    allowAdded: string[];
    denyAdded: string[];
    skipped: string[];
  }> {
    // Read existing settings
    let settings: Record<string, unknown> = {};
    try {
      const data = await Deno.readTextFile(settingsPath);
      settings = JSON.parse(data);
    } catch {
      // File doesn't exist — start fresh
    }

    // Get or create permissions object
    const perms = (settings.permissions ?? {}) as Record<string, unknown>;
    const existingAllow = new Set((perms.allow as string[]) ?? []);
    const existingDeny = new Set((perms.deny as string[]) ?? []);

    const allowAdded: string[] = [];
    const denyAdded: string[] = [];
    const skipped: string[] = [];

    for (const entry of this.entries.values()) {
      if (entry.status === "approved") {
        if (existingAllow.has(entry.pattern)) {
          skipped.push(entry.pattern);
        } else {
          allowAdded.push(entry.pattern);
          existingAllow.add(entry.pattern);
        }
      } else if (entry.status === "rejected") {
        if (existingDeny.has(entry.pattern)) {
          skipped.push(entry.pattern);
        } else {
          denyAdded.push(entry.pattern);
          existingDeny.add(entry.pattern);
        }
      }
      // pending entries are not synced — user hasn't decided yet
    }

    if (!opts?.dryRun && (allowAdded.length > 0 || denyAdded.length > 0)) {
      perms.allow = Array.from(existingAllow);
      perms.deny = Array.from(existingDeny);
      // Clean up empty arrays
      if ((perms.allow as string[]).length === 0) delete perms.allow;
      if ((perms.deny as string[]).length === 0) delete perms.deny;
      settings.permissions = perms;

      const dir = settingsPath.substring(0, settingsPath.lastIndexOf("/"));
      await Deno.mkdir(dir, { recursive: true });
      await Deno.writeTextFile(settingsPath, JSON.stringify(settings, null, 2) + "\n");
    }

    return { allowAdded, denyAdded, skipped };
  }
}

// --- Process-wide singleton + serialized mutation chain ---
//
// The web dashboard previously did `new PermissionLedger() → load → mutate →
// save` for every approve/reject request. Two concurrent requests would each
// load the same on-disk state, each mutate their own copy, then each save —
// the later save clobbers whichever mutation landed first. That's a
// read-modify-write race on security-critical state.
//
// The fix is to keep one ledger per process and serialize mutations through
// a single FIFO chain. Each link re-loads before mutating so cross-process
// writers (CLI, other expo instances) can't be clobbered either.

let _sharedLedger: PermissionLedger | null = null;
let _sharedMutationChain: Promise<unknown> = Promise.resolve();

/** Return the process-wide ledger, constructing it lazily on first call.
 *  Subsequent calls return the same instance; `opts` is only honored on the
 *  first call (it's a no-op after that — mirrors how a real singleton
 *  behaves). Call `resetPermissionLedgerSingleton()` to drop the reference
 *  (tests only). */
export function getPermissionLedger(opts?: { filePath?: string; cwd?: string }): PermissionLedger {
  if (!_sharedLedger) {
    _sharedLedger = new PermissionLedger(opts);
  }
  return _sharedLedger;
}

/** Serialize a load → mutate → save cycle against every other in-flight
 *  mutation. Guarantees no lost writes even when many handlers call
 *  concurrently. The callback may be sync or async; its return value is
 *  passed through to the caller after the save completes. */
export async function mutatePermissionLedger<T>(
  fn: (ledger: PermissionLedger) => T | Promise<T>,
  opts?: { filePath?: string; cwd?: string },
): Promise<T> {
  const ledger = getPermissionLedger(opts);
  const next = _sharedMutationChain.then(async () => {
    await ledger.load();
    const result = await fn(ledger);
    await ledger.save();
    return result;
  });
  // Swallow errors on the chain itself so one failed mutation doesn't
  // poison every subsequent one. The caller still sees the original
  // rejection through `next`.
  _sharedMutationChain = next.catch(() => {});
  return next;
}

/** Reset module-level state. Intended for tests that need a clean slate
 *  between cases; production code should not call this. */
export function resetPermissionLedgerSingleton(): void {
  _sharedLedger = null;
  _sharedMutationChain = Promise.resolve();
}
