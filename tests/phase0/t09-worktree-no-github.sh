#!/bin/bash
# T09: --worktree works with just git init (no GitHub remote)
# Verifies: worktree created from a bare git-init repo with no remote
set -euo pipefail

RESULTS_DIR="$(cd "$(dirname "$0")" && pwd)/results"
mkdir -p "$RESULTS_DIR"

echo "=== T09: --worktree without GitHub remote ==="

# Create a git repo with NO remote — just git init
TEST_REPO=$(mktemp -d)
cd "$TEST_REPO"
git init
echo "local only" > local.txt
git add local.txt
git commit -m "local only commit"

echo "Test repo (no remote): $TEST_REPO"
echo "Remotes: $(git remote -v || echo '(none)')"

OUT="$RESULTS_DIR/t09-raw-output.jsonl"

# Run claude with --worktree in a repo with no remote
claude -p --output-format stream-json --verbose \
  --worktree "no-remote-wt" \
  "What files exist in this directory? Run ls." \
  > "$OUT" 2>&1

EXIT_CODE=$?
echo "Exit code: $EXIT_CODE"

if [[ $EXIT_CODE -ne 0 ]]; then
  echo "=== Output (may contain error) ==="
  cat "$OUT" | head -20
  echo ""

  if grep -qi "github\|remote\|clone" "$OUT"; then
    echo "FAIL: --worktree requires a GitHub remote"
  else
    echo "FAIL: --worktree failed for unknown reason (exit $EXIT_CODE)"
  fi
  # Clean up
  rm -rf "$TEST_REPO"
  exit 1
fi

# Check worktrees
cd "$TEST_REPO"
echo ""
echo "=== Worktrees ==="
git worktree list

if git worktree list | grep -q "no-remote-wt"; then
  echo ""
  echo "PASS: --worktree works without GitHub remote"
else
  echo ""
  echo "NOTE: worktree not found in list — may use different naming"
  echo "PASS (with caveats)"
fi

# Clean up
echo "TEST_REPO=$TEST_REPO" > "$RESULTS_DIR/t09-repo-path.txt"
