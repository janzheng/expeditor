/**
 * Agent Registry — Persists agent→session→worktree mappings to disk
 *
 * Survives process restarts. Stored as a JSON file.
 */

export interface RegistryEntry {
  agentId: string;
  sessionId: string;
  name: string;
  label?: string;
  pid?: number;
  cwd: string;
  worktreePath?: string;
  worktreeName?: string;
  status: "running" | "done" | "failed";
  startedAt: number;
  finishedAt?: number;
  exitCode?: number;
  prompt?: string;
  model?: string;
}

const DEFAULT_REGISTRY_PATH = ".sigbus/registry.json";

export class Registry {
  private entries: Map<string, RegistryEntry> = new Map();
  private filePath: string;

  constructor(opts?: { filePath?: string; cwd?: string }) {
    const cwd = opts?.cwd ?? Deno.cwd();
    this.filePath = opts?.filePath ?? `${cwd}/${DEFAULT_REGISTRY_PATH}`;
  }

  /** Load registry from disk */
  async load(): Promise<void> {
    try {
      const data = await Deno.readTextFile(this.filePath);
      const entries: RegistryEntry[] = JSON.parse(data);
      this.entries.clear();
      for (const entry of entries) {
        this.entries.set(entry.agentId, entry);
      }
    } catch {
      // File doesn't exist yet — start empty
      this.entries.clear();
    }
  }

  /** Save registry to disk */
  async save(): Promise<void> {
    const dir = this.filePath.substring(0, this.filePath.lastIndexOf("/"));
    await Deno.mkdir(dir, { recursive: true });
    const data = JSON.stringify(Array.from(this.entries.values()), null, 2);
    await Deno.writeTextFile(this.filePath, data);
  }

  /** Register a new agent */
  async register(entry: RegistryEntry): Promise<void> {
    this.entries.set(entry.agentId, entry);
    await this.save();
  }

  /** Update an existing agent */
  async update(
    agentId: string,
    updates: Partial<RegistryEntry>,
  ): Promise<void> {
    const entry = this.entries.get(agentId);
    if (entry) {
      Object.assign(entry, updates);
      await this.save();
    }
  }

  /** Get a specific agent */
  get(agentId: string): RegistryEntry | undefined {
    return this.entries.get(agentId);
  }

  /** Get all entries */
  getAll(): RegistryEntry[] {
    return Array.from(this.entries.values());
  }

  /** Get entries by status */
  getByStatus(status: RegistryEntry["status"]): RegistryEntry[] {
    return this.getAll().filter((e) => e.status === status);
  }

  /** Remove an entry */
  async remove(agentId: string): Promise<void> {
    this.entries.delete(agentId);
    await this.save();
  }

  /** Find agent by session ID */
  findBySession(sessionId: string): RegistryEntry | undefined {
    return this.getAll().find((e) => e.sessionId === sessionId);
  }
}
