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
    } catch {
      // File doesn't exist yet — start empty
      this.entries.clear();
    }
  }

  /** Save ledger to disk */
  async save(): Promise<void> {
    const dir = this.filePath.substring(0, this.filePath.lastIndexOf("/"));
    await Deno.mkdir(dir, { recursive: true });
    const data = JSON.stringify(Array.from(this.entries.values()), null, 2);
    await Deno.writeTextFile(this.filePath, data);
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
}
