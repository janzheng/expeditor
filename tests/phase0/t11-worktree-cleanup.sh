#!/bin/bash
# T11: --worktree cleanup — is worktree removed on exit?
# Verifies: check worktree directory existence after session ends
# Depends on: T08 or T10 (uses their repo)
set -euo pipefail

RESULTS_DIR="$(cd "$(dirname "$0")" && pwd)/results"
mkdir -p "$RESULTS_DIR"

echo "=== T11: worktree cleanup after exit ==="

# Try T10's repo first, then T08's
for f in t10-repo-path.txt t08-repo-path.txt; do
  if [[ -f "$RESULTS_DIR/$f" ]]; then
    source "$RESULTS_DIR/$f"
    break
  fi
done

if [[ -z "${TEST_REPO:-}" ]]; then
  echo "SKIP: no test repo from T08/T10 — run those first"
  exit 2
fi

echo "Test repo: $TEST_REPO"

if [[ ! -d "$TEST_REPO" ]]; then
  echo "SKIP: test repo no longer exists"
  exit 2
fi

cd "$TEST_REPO"

echo ""
echo "=== Current worktrees ==="
git worktree list

# Count worktrees (excluding the main one)
WT_COUNT=$(git worktree list | wc -l | tr -d ' ')
echo "Total worktrees (including main): $WT_COUNT"

if [[ $WT_COUNT -eq 1 ]]; then
  echo ""
  echo "RESULT: Claude cleaned up the worktree on exit"
  echo "This means --worktree is self-cleaning — no manual cleanup needed"
else
  echo ""
  echo "RESULT: Worktree(s) still exist after session ended"
  echo "This means we need to manage cleanup ourselves"
  echo ""
  echo "Remaining worktrees:"
  git worktree list | grep -v "$(git rev-parse --show-toplevel)$" || echo "(none besides main)"
fi

# Also check for any .claude worktree artifacts
echo ""
echo "=== .claude directory contents (if any) ==="
ls -la "$TEST_REPO/.claude/" 2>/dev/null || echo "(no .claude directory)"

# Document findings
cat > "$RESULTS_DIR/t11-cleanup-findings.md" << EOF
# T11: Worktree Cleanup Findings

- Repo: $TEST_REPO
- Worktree count after exit: $WT_COUNT
- Self-cleaning: $([ $WT_COUNT -eq 1 ] && echo "YES" || echo "NO")

## Worktree list
\`\`\`
$(git worktree list)
\`\`\`
EOF

echo ""
echo "PASS (findings documented)"
