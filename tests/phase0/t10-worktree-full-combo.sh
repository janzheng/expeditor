#!/bin/bash
# T10: --worktree + --name + -p + stream-json all compose
# Verifies: all flags work together
set -euo pipefail

RESULTS_DIR="$(cd "$(dirname "$0")" && pwd)/results"
mkdir -p "$RESULTS_DIR"

echo "=== T10: full flag composition ==="

TEST_REPO=$(mktemp -d)
cd "$TEST_REPO"
git init
echo "combo test" > combo.txt
git add combo.txt
git commit -m "combo test"

SESSION_ID=$(python3 -c "import uuid; print(uuid.uuid4())")
echo "Test repo: $TEST_REPO"
echo "Session ID: $SESSION_ID"

OUT="$RESULTS_DIR/t10-raw-output.jsonl"

# The big combo: worktree + name + session-id + print + stream-json
claude -p \
  --output-format stream-json --verbose \
  --worktree "combo-wt" \
  --name "combo-test-agent" \
  --session-id "$SESSION_ID" \
  "Run pwd and echo done." \
  > "$OUT" 2>&1

EXIT_CODE=$?
echo "Exit code: $EXIT_CODE"

if [[ $EXIT_CODE -ne 0 ]]; then
  echo "=== Output ==="
  head -20 "$OUT"
  echo "FAIL: flag combination failed (exit $EXIT_CODE)"
  rm -rf "$TEST_REPO"
  exit 1
fi

# Validate output is JSONL
total=$(wc -l < "$OUT" | tr -d ' ')
invalid=$(python3 -c "
import json
count = 0
for line in open('$OUT'):
    try: json.loads(line)
    except: count += 1
print(count)
")

echo "Lines: $total, Invalid: $invalid"

if [[ "$invalid" != "0" ]]; then
  echo "FAIL: invalid JSON in output"
  exit 1
fi

# Check worktree exists
cd "$TEST_REPO"
echo ""
echo "=== Worktrees ==="
git worktree list

echo ""
echo "Session ID: $SESSION_ID"
echo "To resume: claude --resume $SESSION_ID"
echo ""
echo "TEST_REPO=$TEST_REPO" > "$RESULTS_DIR/t10-repo-path.txt"
echo "SESSION_ID=$SESSION_ID" >> "$RESULTS_DIR/t10-repo-path.txt"
echo "PASS: all flags compose correctly"
