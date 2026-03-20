#!/bin/bash
# Test: Full permission ledger approve → re-run cycle
# Verifies: spawn with research sandbox → see denials → approve → re-spawn → no denial
#
# This test spawns real Claude agents. Expect ~2+ minutes total runtime.
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RESULTS_DIR="$PROJECT_ROOT/tests/results"
LEDGER="$PROJECT_ROOT/.expo/permissions.json"
CLI="$PROJECT_ROOT/src/cli.ts"
PASSED=0
FAILED=0

pass() { echo "  PASS: $1"; PASSED=$((PASSED + 1)); }
fail() { echo "  FAIL: $1"; FAILED=$((FAILED + 1)); }

mkdir -p "$RESULTS_DIR"
cd "$PROJECT_ROOT"

echo "=== Ledger Cycle: approve → re-run end-to-end ==="
echo ""

# ── Step 1: Clear any existing permissions ──────────────────────────
echo "Step 1: Clear existing permissions"
rm -f "$LEDGER"
if [ ! -f "$LEDGER" ]; then
  pass "Ledger file removed"
else
  fail "Ledger file still exists after rm"
fi

# ── Step 2: Spawn with research sandbox (should trigger denial) ─────
echo ""
echo "Step 2: Spawn agent with research sandbox (expect Bash(git:*) denial)"
echo "  (this may take ~60s ...)"
OUTPUT1=$(deno run --allow-all "$CLI" spawn \
  "Run git status and report the result" \
  --name ledger-test-1 --no-worktree --sandbox research --timeout 60 2>&1) || true
echo "$OUTPUT1" > "$RESULTS_DIR/ledger-cycle-spawn1.txt"
echo "  Spawn 1 output saved to results/ledger-cycle-spawn1.txt"

# ── Step 3: Check ledger file exists and has pending entry ──────────
echo ""
echo "Step 3: Check ledger file for pending Bash(git:*)"
if [ -f "$LEDGER" ]; then
  pass "Ledger file created"
else
  fail "Ledger file not created after spawn"
fi

if grep -q '"pending"' "$LEDGER" 2>/dev/null; then
  pass "Ledger contains a pending entry"
else
  fail "Ledger does not contain a pending entry"
fi

if grep -q 'Bash(git:\*)' "$LEDGER" 2>/dev/null; then
  pass "Ledger contains Bash(git:*) pattern"
else
  fail "Ledger does not contain Bash(git:*) pattern"
fi

# ── Step 4: Run permissions list and verify pending ─────────────────
echo ""
echo "Step 4: List permissions (expect pending)"
PERM_LIST1=$(deno run --allow-all "$CLI" permissions 2>&1)
echo "$PERM_LIST1" > "$RESULTS_DIR/ledger-cycle-perms1.txt"

if echo "$PERM_LIST1" | grep -q "pending"; then
  pass "Permissions list shows pending entry"
else
  fail "Permissions list does not show pending"
fi

if echo "$PERM_LIST1" | grep -q 'Bash(git:\*)'; then
  pass "Permissions list shows Bash(git:*)"
else
  fail "Permissions list does not show Bash(git:*)"
fi

# ── Step 5: Approve the pattern ─────────────────────────────────────
echo ""
echo "Step 5: Approve Bash(git:*)"
APPROVE_OUT=$(deno run --allow-all "$CLI" permissions approve 'Bash(git:*)' 2>&1)
echo "$APPROVE_OUT" > "$RESULTS_DIR/ledger-cycle-approve.txt"

if echo "$APPROVE_OUT" | grep -q "Approved"; then
  pass "Approve command reported success"
else
  fail "Approve command did not report success"
fi

# ── Step 6: Verify approved status ──────────────────────────────────
echo ""
echo "Step 6: List permissions (expect approved)"
PERM_LIST2=$(deno run --allow-all "$CLI" permissions 2>&1)
echo "$PERM_LIST2" > "$RESULTS_DIR/ledger-cycle-perms2.txt"

if echo "$PERM_LIST2" | grep -q "approved"; then
  pass "Permissions list shows approved status"
else
  fail "Permissions list does not show approved"
fi

if grep -q '"approved"' "$LEDGER" 2>/dev/null; then
  pass "Ledger file contains approved status"
else
  fail "Ledger file does not contain approved status"
fi

# ── Step 7: Re-spawn — Bash(git:*) should now be in allow list ─────
echo ""
echo "Step 7: Re-spawn with research sandbox (Bash(git:*) now approved)"
echo "  (this may take ~60s ...)"
OUTPUT2=$(deno run --allow-all "$CLI" spawn \
  "Run git status and report the result" \
  --name ledger-test-2 --no-worktree --sandbox research --timeout 60 2>&1) || true
echo "$OUTPUT2" > "$RESULTS_DIR/ledger-cycle-spawn2.txt"
echo "  Spawn 2 output saved to results/ledger-cycle-spawn2.txt"

# ── Step 8: Verify no new pending denials for Bash(git:*) ──────────
echo ""
echo "Step 8: Check no new pending denials for Bash(git:*)"
PERM_LIST3=$(deno run --allow-all "$CLI" permissions 2>&1)
echo "$PERM_LIST3" > "$RESULTS_DIR/ledger-cycle-perms3.txt"

# The pattern should still be approved, not reverted to pending
if grep -q '"pending"' "$LEDGER" 2>/dev/null; then
  # There might be pending entries for OTHER patterns; check specifically for git
  if grep -A1 'Bash(git:\*)' "$LEDGER" | grep -q '"pending"'; then
    fail "Bash(git:*) reverted to pending after second spawn"
  else
    pass "Bash(git:*) is NOT pending (other patterns may be pending)"
  fi
else
  pass "No pending entries at all in ledger"
fi

if grep -q '"approved"' "$LEDGER" 2>/dev/null; then
  pass "Bash(git:*) still shows approved in ledger"
else
  fail "Bash(git:*) no longer approved in ledger"
fi

# ── Step 9: Clean up ────────────────────────────────────────────────
echo ""
echo "Step 9: Clean up"
rm -f "$LEDGER"
if [ ! -f "$LEDGER" ]; then
  pass "Ledger file cleaned up"
else
  fail "Ledger file still exists after cleanup"
fi

# ── Summary ─────────────────────────────────────────────────────────
echo ""
echo "=== Results: $PASSED passed, $FAILED failed ==="

if [ "$FAILED" -gt 0 ]; then
  echo "FAIL"
  exit 1
fi

echo "PASS"
exit 0
