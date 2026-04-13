# REFINE.md

Cross-session learning log for the `--help/` refinement target.

## Current state

The `--help/` directory is **empty** apart from `.refine/` metadata. There is no content yet to refine — no source file, no artifact, no prompt. The agent correctly declared convergence immediately: you cannot improve nothing.

## Heuristics learned

- **Check for a refinement target before iterating.** If the working directory has no substantive content (only `.refine/` metadata), the correct first action is to declare convergence and stop, not to invent content.
- **Don't fabricate a target.** Generating a file to then refine would conflate creation with refinement. Those are different tasks.
- **Empty ≠ broken.** An empty target is a valid terminal state for refinement; it's a signal that the user needs to seed content first.

## Suggestions for next session

1. Before starting, confirm with the user what should be in `--help/` — is this meant to hold a help doc, a CLI `--help` output spec, or something else entirely?
2. If a seed file is added (e.g. `help.md`, `usage.txt`), re-run refinement against that specific file rather than the whole directory.
3. Consider whether the directory name `--help` is intentional (CLI-flag-style naming) or a placeholder — it may affect what "better" means here.

## Session log

- **Session 1 (2026-04-13):** 2 variants, 0 discarded. Baseline captured empty directory; agent declared convergence immediately because there is no content to refine. No changes made.
