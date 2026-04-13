# Shakedown A — round 2

Fired 2026-04-13 afternoon after fixing Findings #1–#5 from round 1.
Same parameters as round 1 (10 iter, 3600s, $15, `src/**`+`tests/**` scope)
except added `--force-stale-baseline` because 8.9k lines of committed
work existed between `refine/021` and main HEAD.

## Primary artifacts

- `stdout.log` — full refine log (copy of `/tmp/expo-on-expo-round2-...log`).
- `iter-summary.txt` — grep extract of per-iteration verdicts + final result.
- `command.sh` — the exact expo invocation.
- `repo-before.txt` — git state snapshot at fire time.

## Key outcome

- Verdict: **CONVERGED** (vs round 1's MAX_ITERATIONS).
- 9 iterations, 0 session keeps, 8 discards.
- Cost: $8.64.
- All 5 fixed findings demonstrably working in the run.
- **New Finding #7 surfaced during post-run analysis** — see the
  "Round 2" section of `../2026-04-13-expo-on-expo/findings.md`.

Full analysis in the main findings.md file under "# Round 2" heading.

## Note on the `.refine/manifest.json` state

Round 2 added variants 032–040 to the manifest. Variant 040 is a
"no change" convergence keep. These are preserved in git tags
(`refine/032` through `refine/040`) but the commits they point to
were WIPED from main branch history via `git reset --hard` to
recover from Finding #7. The tags still point to the pre-reset
commit SHAs, so the snapshot tree is intact even though main's
history no longer references those commits.

If you run `expo refine . --tree`, you'll see all 41 variants.
If you run `git log main`, you'll only see up to `1e41888` (the
fix commit) + whatever fixes I've committed since.

This is the exact pathology Finding #7 describes.
