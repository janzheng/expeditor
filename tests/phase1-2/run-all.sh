#!/bin/bash
# Phase 1-2: Signal bus + spawner tests
set -uo pipefail
cd "$(dirname "$0")"

RESULTS_DIR="results"
mkdir -p "$RESULTS_DIR"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'
BOLD='\033[1m'; NC='\033[0m'

pass=0; fail=0; skip=0

run_test() {
  local script="$1"
  local name=$(basename "$script" .sh)
  printf "${BOLD}%-50s${NC} " "$name"

  if [[ ! -x "$script" ]]; then
    printf "${YELLOW}SKIP${NC} (not executable)\n"
    ((skip++))
    return
  fi

  local log="$RESULTS_DIR/${name}.log"
  if bash "$script" > "$log" 2>&1; then
    printf "${GREEN}PASS${NC}\n"
    ((pass++))
  else
    local exit_code=$?
    if [[ $exit_code -eq 2 ]]; then
      printf "${YELLOW}SKIP${NC}\n"
      ((skip++))
    else
      printf "${RED}FAIL${NC} (see $log)\n"
      ((fail++))
    fi
  fi
}

echo ""
echo -e "${BOLD}Phase 1-2: Signal Bus + Spawner Tests${NC}"
echo "================================================="
echo ""

if [[ $# -gt 0 ]]; then
  script="t${1}-*.sh"
  matches=($(ls $script 2>/dev/null))
  if [[ ${#matches[@]} -eq 0 ]]; then
    echo "No test matching: $script"
    exit 1
  fi
  for m in "${matches[@]}"; do run_test "$m"; done
else
  for script in t[0-9][0-9]-*.sh; do
    [[ -f "$script" ]] || continue
    run_test "$script"
  done
fi

echo ""
echo "================================================="
echo -e "Results: ${GREEN}${pass} pass${NC}, ${RED}${fail} fail${NC}, ${YELLOW}${skip} skip${NC}"
echo ""
[[ $fail -eq 0 ]] || exit 1
