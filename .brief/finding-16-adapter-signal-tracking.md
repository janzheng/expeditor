# Finding #16 Root-Cause — Adapter-Signal Agent-Touched-Path Tracking

**Status:** ready
**From:** Finding #16 + follow-up (`beec601`) closed the silent-wipe
class at the heuristic level but left a residual race: a user writing
a file AFTER agent spawn is indistinguishable from agent-created.
**Task:** `-> TASKS.md` — new item to be added if we decide to pursue

## Problem

`recordDiscardAndMaybeBranch`'s cleanup path uses pre/post dirty-diff
to infer "paths the agent touched this iteration":

```
agentTouchedPaths = postAgentDirty - preAgentDirty
```

That's **inference**, not observation, and it's subject to two classes
of race:

1. **User writes between `preAgentDirty` capture and agent spawn.**
   Fixed by the Finding #16 follow-up via mtime-skip (`beec601`) —
   the file's mtime predates the spawn, so cleanup skips it.
2. **User writes AFTER agent spawn, during the agent run.** Mtime is
   post-spawn, indistinguishable from agent-created. Cleanup will
   wipe it if it lands in agentTouchedPaths and a discard fires.

The concurrency BRIEF (`snapshot/.brief/concurrency-contract.md`)
handles case 2 **architecturally** by refusing concurrent operations
outright via a heartbeat lock. That's the right fix for snapshot's
single-writer contract. But expo's refine loop itself is the
"other writer" — the harness IS the process the user is running
concurrently with whatever else they're doing. The concurrency BRIEF
keeps _two snapshot library consumers_ from colliding; it doesn't
help when refine's cleanup logic consumes user files because it
can't tell them from agent output.

The real fix is to stop inferring "what the agent touched" and
start **observing** it directly.

## Investigation

### What signals do we have?

Expo's bus captures every adapter's event stream. For adapters with
structured output:

- **claude**: `tool_use` events with full input (file path for
  Edit/Write/MultiEdit; command string for Bash). Captured via
  `src/adapters/claude-adapter.ts`.
- **codex**: `command_execution` events with command string +
  aggregated_output. No separate tool-by-tool file-path signal.
- **opencode**: `tool_use` events with tool name, input, and output
  (post-execution snapshot).
- **pi**: `tool_execution_start` + `tool_execution_end` with tool
  name, arguments, and results.
- **generic**: nothing structured — raw stdout only.

For **claude** specifically, every file-modifying action leaves a
trace:

```json
{"type": "tool_use", "name": "Edit", "input": {"file_path": "src/foo.ts", ...}}
{"type": "tool_use", "name": "Write", "input": {"file_path": "new.txt", ...}}
{"type": "tool_use", "name": "MultiEdit", "input": {"file_path": "x", "edits": [...]}}
{"type": "tool_use", "name": "Bash", "input": {"command": "rm -rf foo", ...}}
```

The file-targeted tools are easy — the path is right there in
`input.file_path`. **Bash is the hard case** because a shell command
can affect arbitrary paths; we can't derive affected paths from the
command string alone without parsing shell syntax.

### Design space

#### Option A — Direct tool_use tracking for file-modifying tools + Bash-scoped diff

Build the agent-touched set from two sources:

1. **Direct from tool_use events:** for every Edit/Write/MultiEdit/
   NotebookEdit tool call, add `input.file_path` to the touched set.
2. **Scoped diff around each Bash:** immediately before each Bash
   tool_use, capture `preBashDirty = listDirtyPaths(dir)`. After
   the Bash completes (tool_result event arrives), capture
   `postBashDirty`. The diff is authoritative for paths that Bash
   affected. Add those to the touched set.

Implementation shape:

```typescript
const agentTouchedPaths = new Set<string>();
bus.subscribe(async (signal) => {
  if (signal.agentId !== agentName) return;
  if (signal.type === "tool_use") {
    const { name, input } = signal.payload;
    if (["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(name)) {
      agentTouchedPaths.add(normalizePath(input.file_path, dir));
    } else if (name === "Bash") {
      // Capture pre-Bash dirty; the matching tool_result handler
      // captures post-Bash and computes the diff.
      preBashDirty.set(signal.toolUseId, await listDirtyPaths(dir));
    }
  } else if (signal.type === "tool_result" && signal.payload.toolUseId) {
    const pre = preBashDirty.get(signal.payload.toolUseId);
    if (pre) {
      const post = await listDirtyPaths(dir);
      for (const p of post) if (!pre.has(p)) agentTouchedPaths.add(p);
      preBashDirty.delete(signal.payload.toolUseId);
    }
  }
});
```

- **Race window shrinks from "entire agent run" to "single Bash
  call."** Typical Bash call is sub-second; the race window is
  ~50ms-1s vs the current 30s-15min agent run.
- Works for claude. For opencode/pi, adapt to their tool_use shape.
- Codex lacks tool-by-tool events — falls back to dirty-diff (or a
  per-command_execution diff using the `command` field similarly).
- Generic stays on the dirty-diff heuristic.
- **Implementation:** ~150-250 LOC across refine.ts + adapter hooks.

#### Option B — Pre-agent tree snapshot + post-agent diff

Use git's object database: before the agent runs, `git write-tree`
captures the working tree (including untracked via `git add -A`
into a temp index). After, compare trees.

- Simple, uses existing git plumbing.
- Doesn't help: a user write during the agent run also shows up in
  the post-tree diff, because it's comparing "before agent" to
  "after agent." Same problem we have now, different machinery.
- **Not a fix.** Included for completeness.

#### Option C — Filesystem-level tracking (fsevents / inotify)

Register a filesystem watcher for the duration of the agent run,
tagged with the agent's pid. Every write event is attributed to its
originating pid. If user writes from a different pid, exclude.

- Fully correct.
- Platform-specific (macOS fsevents, Linux inotify, Windows
  ReadDirectoryChangesW). Deno doesn't ship native bindings.
- FFI or wrapping CLI tools (`fswatch`, `inotifywait`) is brittle
  and adds deployment dependencies.
- **Complexity:** 500+ LOC, platform-matrix testing, new runtime
  deps. Disproportionate to the residual race's actual frequency.

#### Option D — Sandboxed agent workspace

Spawn agent in a separate worktree / container / tmpfs clone. User's
main tree is untouched regardless of what happens. Refine diffs the
workspaces and promotes good variants via commits.

- Fully correct.
- **Huge architectural change.** Refine today operates in-tree
  precisely because `restore()` needs direct access to the project
  tree. Worktree isolation means restoring from a `refine/NNN` tag
  is a cross-worktree copy, not a local checkout.
- Would rewrite most of `src/refine.ts` + the snapshot backend's
  contract with the project tree.
- Not shippable as a follow-up; would be a v2 rewrite.

#### Option E — Leave it, point at the concurrency BRIEF

Don't fix the post-spawn race in expo. Document the limitation.
Users who hit it solve it via snapshot's fail-loud heartbeat contract
(when shipped) — which refuses any concurrent operations including
"refine is running, don't also be writing files here."

- Zero implementation cost.
- Punts the problem to a BRIEF that hasn't shipped yet.
- Pragmatic: the race is narrow, the affected user class is small
  (users/agents writing concurrent with refine — mostly assistants,
  not typical developers), and the heartbeat BRIEF directly addresses
  it once implemented.

## Recommendation

**Ship option A (adapter-signal tracking) only if usage reveals the
race is a real problem after the concurrency BRIEF's fail-loud
heartbeat lands.** For now, **option E** is the right call.

Reasoning:

- **The concurrency BRIEF is the architectural fix** for this class
  of race. Once shipped (~50 LOC per the BRIEF), a user running
  refine cannot have another process writing into the same tree —
  the heartbeat refuses. The race becomes impossible, not just
  unlikely.
- **Option A is the "correct" fix** but only pays off if users want
  to continue running concurrent operations WITH refine. The BRIEF's
  fail-loud model says "no, you can't." If we ship both, we've
  built a precise tracker for a case the concurrency layer already
  prevents — wasted effort.
- **The race's actual frequency is low**. Affected parties: AI
  assistants writing alongside refine (my BRIEF file disappearing),
  watch-mode tools, aggressive IDE autosave. All niche. Typical
  dev workflow is "kick off refine, go do something else" — no
  tree writes during the run.
- **Mtime-skip + per-removal logging (shipped) is sufficient for
  the common case.** The remaining race is a known, documented edge.
- **Option A has real complexity.** Bash-scoped diff introduces new
  race windows (user writes during Bash execution). Per-adapter
  event shape handling bloats the adapter layer. Works around a
  limitation rather than solving it.

Explicitly rejected:

- ~~Option B~~: doesn't actually fix the race.
- ~~Option C~~: disproportionate complexity for the payoff.
- ~~Option D~~: v2 architecture, not a follow-up.

## Conditional Implementation Path (if option A is ever needed)

Triggers to revisit this BRIEF and pursue option A:

1. Users actively complain that heartbeat fail-loud is too strict
   and want to run concurrent operations.
2. Adapter-signal tracking gets built for another reason (e.g. better
   per-tool cost attribution, more accurate agent-touched display
   in the dashboard) — at that point option A is cheap to add.
3. The Finding #17 MCP tool-use BRIEF ships its verdict-submission
   tool; adding a `declare_touched` tool for agents to self-report
   file operations becomes a natural extension.

If revisited, implementation order:

1. **Adapter hook layer.** Wire each structured-output adapter's
   tool_use events into a per-agent "touched paths" builder. Keep
   the old dirty-diff as a fallback when the builder returns an
   empty set (e.g., for generic adapter or agents that didn't emit
   tool_use).
2. **Bash-scoped dirty diff.** For Bash tool calls specifically,
   capture dirty paths immediately before and after. Narrows the
   race to sub-second window per Bash.
3. **Path normalization.** Tools emit absolute paths; the cleanup
   code expects paths relative to `dir`. Normalize at capture time.
4. **Test coverage.** Unit tests per adapter: given a synthetic
   stream of tool_use events, verify the touched-path set is built
   correctly. Integration test: full refine iter with a simulated
   user-write during the agent run, verify cleanup preserves the
   user's file.

**Acceptance:** a test that simulates a user writing `./user.md`
100ms after agent spawn, agent doing Edit on `./src/foo.ts`,
iteration ends as scope_violation discard — verify `user.md`
survives AND `src/foo.ts` is restored (assuming it was tracked) /
cleaned (if it was new).

## Out of scope

- Codex's lack of per-tool file-path signals — fallback to
  dirty-diff is acceptable for now given codex isn't the primary
  adapter.
- The philosophical question of "should refine's cleanup exist at
  all if we have structured tool_use?" (i.e., maybe we should just
  snapshot + restore and let tracked state handle everything). The
  answer depends on whether we want to protect untracked state the
  agent created — currently yes, for the usability argument that
  "straggler files from a discarded attempt shouldn't pollute
  subsequent iterations." Revisit if refine's usage pattern
  changes.
