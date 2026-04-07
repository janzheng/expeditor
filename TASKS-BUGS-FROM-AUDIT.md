# Expo — Bug Report from Brigade Audit

These bugs were found during a correctness audit of `workshop/brigade/`, which contains
a verbatim copy of expo's `src/bus.ts`.

**Source audit:** `workshop/brigade/TASKS-AUDIT.md` — 2026-03-26
**Affected file:** `src/bus.ts`

Fix the original here. Brigade will be updated separately once confirmed fixed.

---

## `src/bus.ts`

- [x] [fixed: fallback path with timestamp if original and renamed both fail, FATAL log if all fail] **BUS-01** Log rotation leaves `logHandle` null on failure `#data-loss`

- [x] [fixed: `rotating` flag + null handle immediately before close, concurrent emit() skips write] **BUS-02** Rotate/emit race `#race-condition`

- [x] [fixed: check size BEFORE write, rotate first if would exceed limit — hard cap] **BUS-03** Log rotation soft cap `#logic-bug`

- [x] [fixed: close existing handle at start of init() if already open] **BUS-04** Double-init leaks file handle `#resource-leak`

- [x] [fixed: moved read loop from start() to pull() — stream respects backpressure, returns after enqueueing] **BUS-05** `lineStream` doesn't handle backpressure `#resource-leak` `#at-scale-only`

- [x] [fixed: on stream error, do NOT flush buffer — partial line is dropped instead of emitted as valid JSON] **BUS-06** Partial final line emitted as complete line on stream error `#error-handling`
