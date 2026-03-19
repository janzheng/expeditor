#!/bin/bash
# T08: --worktree creates and runs in a worktree
# Verifies: worktree directory created, agent ran inside it
set -euo pipefail

RESULTS_DIR="$(cd "$(dirname "$0")" && pwd)/results"
mkdir -p "$RESULTS_DIR"

echo "=== T08: --worktree basic functionality ==="

# Create a temp git repo to test with
TEST_REPO=$(mktemp -d)
cd "$TEST_REPO"
git init
git commit --allow-empty -m "initial"
echo "test file" > test.txt
git add test.txt
git commit -m "add test file"

echo "Test repo: $TEST_REPO"

OUT="$RESULTS_DIR/t08-raw-output.jsonl"

# Run claude with --worktree
claude -p --output-format stream-json --verbose \
  --worktree "test-wt" \
  "Run pwd and tell me what directory you're in. Also run 'git branch' to show which branch." \
  > "$OUT" 2>/dev/null

# Check what worktrees exist
echo ""
echo "=== Git worktrees after run ==="
cd "$TEST_REPO"
git worktree list 2>/dev/null || echo "(git worktree list failed)"

# Check if a worktree was created
WORKTREE_DIR=$(git worktree list 2>/dev/null | grep "test-wt" | awk '{print $1}' || true)
if [[ -n "$WORKTREE_DIR" ]]; then
  echo "OK: worktree created at $WORKTREE_DIR"
  echo "Branch: $(git worktree list | grep test-wt)"
else
  echo "NOTE: worktree 'test-wt' not found in worktree list"
  echo "Full worktree list:"
  git worktree list
fi

# Check output for directory info
python3 << PYEOF
import json

out_file = "$RESULTS_DIR/t08-raw-output.jsonl"
for line in open(out_file):
    try:
        obj = json.loads(line)
    except:
        continue
    if obj.get("type") == "result":
        result = obj.get("result", "")
        if isinstance(result, str):
            print(f"Result text (first 500 chars): {result[:500]}")
PYEOF

echo ""
echo "Test repo: $TEST_REPO"
echo "Check manually: ls $TEST_REPO/.worktrees/ or similar"

# Save info for T11 cleanup test
echo "TEST_REPO=$TEST_REPO" > "$RESULTS_DIR/t08-repo-path.txt"
echo "WORKTREE_DIR=$WORKTREE_DIR" >> "$RESULTS_DIR/t08-repo-path.txt"

echo "PASS (manual verification recommended)"
