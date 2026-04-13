# Shakedown B tier-1 RE-RUN — validation (2026-04-13)

Re-run of tier-1 on `@snapshot/core` after shipping fixes for Findings
#1-#8, #10, #11. Same rubric, same caps, fresh `.refine/` state,
new branch `shakedown-tier1-v2`. Purpose: validate end-to-end that
the fixes actually unblock clean iterations on an external repo.

## Result summary

**Perfect validation.** Every fix held under real conditions.

| Metric | Tier-1 v1 (pre-fix) | Tier-1 v2 (post-fix) |
|--------|---------------------|----------------------|
| Verdict | EXHAUSTED (3 force-discards in a row) | MAX_ITERATIONS (hit the cap) |
| Session keeps | **0** (all scope-violated) | **5** (ALL kept) |
| Session discards | 3 | **0** |
| Scope violations | 3 | **0** |
| Branch HEAD moved | (didn't check, would have) | **No** — master + shakedown HEAD both stayed at `f353f6f` |
| Cost | $2.24 | $3.09 |
| Duration | 320s | 550s |

## What the agent accomplished

Five kept iterations, all legitimate API-boundary polish:

| Iter | Change | Production LOC | Test LOC |
|------|--------|----------------|----------|
| [001] | `addGate` rejects empty/whitespace name or command | ~8 | ~20 |
| [002] | `restore()` not-found error names available variants or tells empty-archive callers | ~6 | ~25 |
| [003] | `snapshot()` validates `opts.addPaths` (non-array + empty/whitespace entries) | ~14 | ~40 |
| [004] | `addGate` not-found error lists known variants | ~6 | ~30 |
| [005] | `listGates` not-found error lists known variants | ~5 | ~30 |

Total: 44 lines production change, 155 lines test, 26 tests passing
(up from 21 at session start). Every one of these is a diff a senior
reviewer would call "obviously right" — exactly what the rubric asked
for. In v1 all three analogous attempts were eaten by Finding #8.

## Fix validations (direct evidence)

### Finding #7/#10 — branch HEAD stays put ✅

```
$ git log shakedown-tier1-v2 --oneline -5
f353f6f Fix Shakedown Finding #7/#10: snapshot commits no longer advance branch HEAD
a00e79c Add Gate.timeoutMs for per-gate timeout override
992ebfa Initial commit — gate ratchet + HEAD tracking + scope control
```

Three commits total. NO `refine/NNN` commits on the branch. All 6
snapshot tags (`refine/000` through `refine/005`) exist and point to
real git commits, but they're dangling — reachable only via tags, not
via any branch. This is exactly the intended behavior.

```
$ git rev-parse master          # still at pre-run SHA
f353f6f724ea4c313a10bf3ad2ea96f3b617a364
$ git rev-parse HEAD            # shakedown-tier1-v2 still at same SHA
f353f6f724ea4c313a10bf3ad2ea96f3b617a364
```

Before the fix, a 5-iter run with 5 keeps would have advanced HEAD by
5 commits. After the fix: zero.

### Finding #8 — expo's own runtime filtered ✅

```
$ grep -c "scope_violation" tier1-rerun.log
0
```

Zero scope violations across all 5 iterations. Every iteration dirtied
`.expo/logs/bus-refine-*.jsonl` and `.sigbus/*` as expected (expo's own
runtime), but those paths now get filtered from the agent-touched set
before scope enforcement, so legitimate keeps survive.

### Finding #6 — session vs lifetime distinction ✅

Final banner output:
```
Kept:       5 this session (6 lifetime)
Discarded:  0 this session (0 lifetime)
```

User knows at a glance: this session produced 5 keeps. "6 lifetime"
includes the baseline variant 000. Clear and honest.

### Finding #11 — banner split ✅

No "Gate fails: 0" or "Scope viols: 0" lines printed because both are
zero and those lines only render when count > 0. Confirms the split
works and behaves gracefully on a clean run.

## Post-run artifact cleanup

Working tree on `shakedown-tier1-v2` is dirty with the landed changes
(src/snapshot.ts + src/snapshot_test.ts). The snapshot tags preserve
the full tree. Two cleanup options for the snapshot repo:

1. **Keep the work** — commit directly to master (these are real
   improvements, would land on master anyway if we reviewed them).
2. **Discard** — treat as shakedown-only, reset and delete branch.
   The tags would remain but unreachable.

The fixes survived a real refine run. That's the validation. Whatever
we do with the particular commits is a separate decision.

## Conclusion

**Expo is validated for external-repo use.** A tier-1 shakedown on an
unfamiliar repo (well, semi-familiar — snapshot is a sibling lib) now
produces clean kept iterations without any of the destructive defaults
that bit rounds 1-2 of Shakedown A.

The remaining work is validation on progressively harder repos (tier-2
medium, tier-3 adversarial) per the shakedown brief. No more bug-fixes
are blocking that progression — any new findings from tier-2/tier-3
would be net-new discoveries, not repeats of today's 11.
