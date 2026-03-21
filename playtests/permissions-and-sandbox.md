# Permissions & Sandbox Playtesting

## Smoke (risk: none)

- [x] [pass] Run `expo permissions` with empty ledger — shows "no entries" message
- [x] [found: silently fell through to list view — FIXED: now shows usage error] Run `expo permissions approve` with no pattern
- [x] [found: same silent fallthrough — FIXED] Run `expo permissions reject` with no pattern
- [x] [pass] Run `expo permissions reset` when no ledger file exists — succeeds silently
- [x] [found: fell through to list — FIXED: now shows "Unknown subcommand" with available list] Run `expo permissions foobar`

## Permission ledger edge cases (risk: low)

- [x] [pass: pre-approve creates entry with status "approved", persists to JSON, merges into sandbox] Approve a pattern that was never denied
- [x] [pass: reject overrides approve — final status wins] Approve then reject the same pattern
- [x] [pass: verified in ledger cycle test — 12/12 pass] Run `expo spawn` with `--sandbox research` and try a git command
- [x] [pass: recordDenials increments count, doesn't overwrite status] Run two spawns back-to-back that both trigger denials

## Sandbox preset validation (risk: none)

- [x] [pass: "Unknown sandbox preset: nonexistent" + shows available list] Run with `--sandbox nonexistent`
- [x] [pass] Run with `--sandbox permissive`
- [x] [pass] Run with `--sandbox research`

## Domain filter (risk: low)

- [x] [pass: 5/5 unit tests — hook script generated with correct domains and blocking logic] Domain filter hook generation

## Multi-agent sandbox (risk: low)

- [x] [pass: pi-mono runs with restricted tools, lists files successfully] Run with `--agent pi --sandbox research`
- [x] [pass: opencode sandbox wiring compiles, generates agent config] Run with `--agent opencode --sandbox research`

## Cost tracking (risk: none)

- [x] [pass: shows per-agent costs ($0.11, $0.11) and breakdown (agents/synthesis/total)] Workflow cost breakdown

## CLI packaging (risk: none)

- [x] [pass: all commands listed, 4 mentions of "permissions"] Run `expo help`
- [x] [pass: works from /tmp, shows "No agents in registry"] Run `expo status` from different directory
- [x] [pass: creates .expo/permissions.json relative to cwd] Run `expo permissions` from different directory
