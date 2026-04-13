# Expo self-refine rubric

You are refining expo's own source, iteratively. The codebase is mature and
gate-covered — the goal is *small, high-confidence polish*, not architectural
change. Treat every proposed iteration as if a reviewer will see the diff.

## Do

- Fix unclear error messages (stderr output, thrown Error.message, bus event
  `reason` fields). "Clearer" means a user reading the message can act on it
  without reading source. Concrete > vague.
- Fix obvious bugs you stumble on: off-by-one, missing await, unhandled
  rejection, wrong default that contradicts the nearby comment.
- Tighten validation at trust boundaries (CLI arg parsing, hook stdout
  parsing, config-file loading). If garbage input silently no-ops a safety
  flag, that's a bug worth a small fix + a test.
- Add regression tests for every behavioral change. No test, no keep. Put
  them in `tests/test-*.ts` following the existing pattern.

## Do not

- Do not extract helpers "for clarity." If you find yourself proposing a
  new helper with 2 or fewer call sites, STOP — the inline version is
  better. We got burned by this in variants 001–003 (see REFINE.md).
- Do not rename files, restructure modules, or reshape public exports.
- Do not touch dashboard HTML or .brief/ / shakedown/ / QUICKSTART.md —
  these are out of scope.
- Do not add new features, new CLI flags, new public API. If you find
  yourself designing something, that's a new session, not this loop.
- Do not "improve" code that already works. A passing gate + a clear
  existing structure is the baseline; don't regress it in the name of
  style.

## Quality bar for KEEP

- Change is under ~40 lines of production code.
- New or updated test exists and passes.
- All inherited gates pass.
- A senior reviewer would describe the change as "obviously right" —
  not "a judgment call."

Everything else is DISCARD. It is better to exit with `verdict: CONVERGED —
no obvious small fixes remain` than to keep a medium-confidence change.

## Priority order (work top-down)

1. User-facing error message clarity in refine / mxit / workflow runners
2. Validation gaps at CLI boundaries (parseIntArg-style fixes)
3. Small bug-fixes uncovered while reading point 1 or 2
4. Tiny consistency wins (wrong log level, misleading comment next to
   correct code, import ordering only when also fixing something else)

If you cannot find a point-1 or point-2 candidate within your first
exploration pass, prefer CONVERGED over digging for point-3 or point-4.
