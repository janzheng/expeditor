# Expo — Project Notes

## Testing

- Tests are shell scripts that spawn real Claude agents via the CLI
- Run `deno task test` (phase 1-2) or `deno task test:all` (all phases)
- Run a single test: `bash tests/phase1-2/run-all.sh 07` (runs t07-race)
- It's fine to run tests freely — the user has a Claude Code subscription so agent spawns are included
