#!/usr/bin/env bash
# Quick single-problem test runner for development.
# Usage:
#   ./scripts/dev.sh "fibonacci"                    # auto-detects domain
#   ./scripts/dev.sh "sort numbers" --domain=math   # explicit domain
#   ./scripts/dev.sh "fib" --no-cache               # skip LLM cache
#
# Prints structured JSON result at the end for programmatic consumption.
# Log saved to logs/ regardless of CACHE_MODE.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"
cd "$ROOT"

# ── Parse args ──────────────────────────────────────────────────────────────

PROBLEM=""
DOMAIN="auto"
CACHE_MODE="${CACHE_MODE:-on}"
EXTRA_ENV=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --domain=*) DOMAIN="${1#--domain=}"; shift ;;
        --no-cache) CACHE_MODE="off"; shift ;;
        --fresh)    CACHE_MODE="clear"; shift ;;
        -h|--help)
            echo "Usage: ./scripts/dev.sh PROBLEM_DESC [--domain=X] [--no-cache] [--fresh]"
            echo ""
            echo "  PROBLEM_DESC    The problem description (quote if multiple words)"
            echo "  --domain=X      Force a specific domain (default: auto)"
            echo "  --no-cache      Disable LLM response cache"
            echo "  --fresh         Clear cache before running"
            echo ""
            echo "Examples:"
            echo "  ./scripts/dev.sh 'fibonacci'"
            echo "  ./scripts/dev.sh 'sort an array' --domain=sorting"
            echo "  ./scripts/dev.sh 'nash equilibrium' --fresh"
            exit 0
            ;;
        *) PROBLEM="$PROBLEM $1"; shift ;;
    esac
done

PROBLEM="${PROBLEM# }"  # trim leading space

if [[ -z "$PROBLEM" ]]; then
    echo "Error: No problem description provided."
    echo "Usage: ./scripts/dev.sh \"problem description\""
    exit 1
fi

# ── Load previous run state (for before/after comparison) ──────────────────

PREV_STATE_FILE="/tmp/truth-engine-dev-state.json"
PREV_SAME_PROBLEM=""
PREV_PASSED=""
PREV_FAILURE=""
PREV_CALLS=""
PREV_TOKENS=""

if [[ -f "$PREV_STATE_FILE" ]]; then
    PREV_DATA=$(python3 -c "
import json
try:
    with open('$PREV_STATE_FILE') as f:
        d = json.load(f)
    if d.get('problem') == '''$PROBLEM''':
        print(json.dumps(d))
except: pass
" 2>/dev/null || echo "")
    if [[ -n "$PREV_DATA" ]]; then
        PREV_SAME_PROBLEM="1"
        PREV_PASSED=$(echo "$PREV_DATA" | python3 -c "import sys,json; print(json.load(sys.stdin).get('passed',''))" 2>/dev/null || echo "")
        PREV_FAILURE=$(echo "$PREV_DATA" | python3 -c "import sys,json; print(json.load(sys.stdin).get('failure',''))" 2>/dev/null || echo "")
        PREV_CALLS=$(echo "$PREV_DATA" | python3 -c "import sys,json; print(json.load(sys.stdin).get('calls',''))" 2>/dev/null || echo "")
        PREV_TOKENS=$(echo "$PREV_DATA" | python3 -c "import sys,json; print(json.load(sys.stdin).get('tokens',''))" 2>/dev/null || echo "")
    fi
fi

# ── Run ────────────────────────────────────────────────────────────────────

echo "╔══════════════════════════════════════════════════════════╗"
echo "║  truth-engine — dev run                                  ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""
echo "  Problem: ${PROBLEM:0:100}"
echo "  Domain:  $DOMAIN"
echo "  Cache:   $CACHE_MODE"
if [[ -n "$PREV_SAME_PROBLEM" ]]; then
    echo "  Previous run: $PREV_PASSED  (comparing against last run of this problem)"
fi
echo ""

START_TS=$(date +%s)

# Capture output to a temp file so we can extract structured JSON afterward,
# while still showing it in real-time via tee.
PIPE_OUT="$(mktemp /tmp/truth-engine-dev-XXXXXX)"
trap "rm -f '$PIPE_OUT'" EXIT

set +e  # capture exit code without crashing
DOMAIN="$DOMAIN" \
PROBLEM_DESC="$PROBLEM" \
CACHE_MODE="$CACHE_MODE" \
NO_UI=1 \
bun run src/main.ts 2>&1 | tee "$PIPE_OUT"
EXIT_CODE=${PIPESTATUS[0]}
set -e

DURATION=$(( $(date +%s) - START_TS ))

# ── Result ─────────────────────────────────────────────────────────────────

LOG_FILE="$(ls -t logs/truth-engine-*.log 2>/dev/null | head -1 || echo '')"

echo ""
echo "──────────────────────────────────────────────────────────────────"
echo "  Exit code: $EXIT_CODE  |  Duration: ${DURATION}s"
echo "  Log: ${LOG_FILE:-none}"
echo "──────────────────────────────────────────────────────────────────"

# ── Structured JSON result (from captured pipeline stdout) ────────────────

JSON_LINE=$(grep '^{"result":{' "$PIPE_OUT" 2>/dev/null | tail -1 || echo "")
if [[ -n "$JSON_LINE" ]]; then
    echo ""
    echo "── Result JSON ──"
    echo "$JSON_LINE" | python3 -m json.tool 2>/dev/null || echo "$JSON_LINE"
fi

# ── Oracle failures (from captured stdout — expected vs got) ──────────────

ORACLE_FAILS=$(grep -i "oracle.*Failed\|expected.*got\|FAIL.*expected\|should be true\|should be false" "$PIPE_OUT" 2>/dev/null | grep -v "possible_failure\|fail.*mode" | tail -10 || echo "")

if [[ -n "$ORACLE_FAILS" ]]; then
    echo ""
    echo "── Oracle discrepancies ──"
    echo "$ORACLE_FAILS"
fi

# ── Pipeline stage results (from captured stdout) ─────────────────────────

PIPELINE_STAGES=$(grep -E "^\s*(PASS|FAIL)\s*\|" "$PIPE_OUT" 2>/dev/null | tail -5 || echo "")
if [[ -n "$PIPELINE_STAGES" ]]; then
    echo ""
    echo "── Stage results ──"
    echo "$PIPELINE_STAGES"
fi

# ── Quick diagnostics (errors from log) ────────────────────────────────────

if [[ -n "$LOG_FILE" && -f "$LOG_FILE" ]]; then
    # Extract errors, skipping prompt/JSON blocks (same filter as logs.sh -e)
    ERRORS=$(awk '
        /^── SYSTEM PROMPT/     { in_skip=1; next }
        /^── USER PROMPT/       { in_skip=1; next }
        /^── PARSED JSON/       { in_json=1; next }
        /^── STATUS: OK/        { in_json=0 }
        /^── RAW RESPONSE/      { in_skip=0; in_json=0 }
        !in_skip && !in_json
    ' "$LOG_FILE" 2>/dev/null | grep -i "── ERROR\b\|exception\|killed\|abort\|stuck\|Traceback\|✗ FAILED\|TERMINATED\|STAGNATION" | grep -v "oracle_js\|function verify\|possible_failure\|fail.*mode" | tail -15 || echo "")

    if [[ -n "$ERRORS" ]]; then
        echo ""
        echo "── Key errors (last 15 lines) ──"
        echo "$ERRORS"
    fi
fi

# ── Failure classification ──────────────────────────────────────────────────

PIPELINE_PASSED=$(echo "$JSON_LINE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('result',{}).get('solved',False))" 2>/dev/null || echo "False")

if [[ "$PIPELINE_PASSED" != "True" && ( $EXIT_CODE -ne 0 || -n "$(grep -i 'EVENT.*FAILED\|killed\|ABORT' "$PIPE_OUT" 2>/dev/null || echo '')" ) ]]; then
    echo ""
    echo "── Failure analysis ──"
    FAILURE_FOUND=""
    CUR_FAILURE=""

    # Check for stuck loops
    if grep -qi "ZOOM OUT\|LOOP DETECTED\|STAGNATION DETECTED\|FAILURE STORM\|terminated.*loop\|same action.*3" "$PIPE_OUT" 2>/dev/null; then
        echo "  STUCK LOOP: Model repeated same action — loop detector terminated it"
        FAILURE_FOUND="1"; CUR_FAILURE="stuck-loop"
    fi

    # Check for premature finish
    if grep -qi "finish.*without.*test\|finish.*before.*pass\|called.*finish.*not.*all.*pass" "$LOG_FILE" 2>/dev/null; then
        echo "  PREMATURE FINISH: Model called finish() before all tests passed"
        FAILURE_FOUND="1"; CUR_FAILURE="premature-finish"
    fi

    # Check for parse failures
    if grep -qi "No valid Action\|invalid action\|could not produce a valid\|parse.*fail" "$LOG_FILE" 2>/dev/null; then
        echo "  PARSE FAILURE: Model output couldn't be parsed — check prompt format"
        FAILURE_FOUND="1"; CUR_FAILURE="parse-failure"
    fi

    # Check for max turns / budget exhaustion
    if grep -qi "max.*turns\|budget.*exhaust\|turn.*limit\|auto-finish" "$LOG_FILE" 2>/dev/null; then
        echo "  BUDGET EXHAUSTED: Task-agent ran out of turns — problem too hard or model too slow"
        FAILURE_FOUND="1"; CUR_FAILURE="budget-exhausted"
    fi

    # Check for all-tests-failing (stub output)
    if [[ -n "$LOG_FILE" && -f "$LOG_FILE" ]]; then
        FAIL_COUNT=$(grep -ci "FAILED.*expected\|failed.*expected\|oracle.*FAIL\|✗ FAILED" "$LOG_FILE" 2>/dev/null || echo "0")
        PASS_COUNT=$(grep -ci "PASS.*expected\|passed.*expected\|oracle.*PASS\|✓ PASS" "$LOG_FILE" 2>/dev/null || echo "0")
        if [[ "$FAIL_COUNT" -ge 3 && "$PASS_COUNT" -eq 0 ]]; then
            echo "  ALL TESTS FAILING: Every test fails — possible stub output (returning 0/None/[])"
            FAILURE_FOUND="1"; CUR_FAILURE="all-tests-failing"
        fi
    fi

    # Check for oracle hardening failure
    if grep -qi "oracle.*hardening.*fail\|weak oracle\|broken stub.*accepted\|bypass.*stub" "$LOG_FILE" 2>/dev/null; then
        echo "  ORACLE HARDENING FAILED: Oracle doesn't reject broken stubs"
        FAILURE_FOUND="1"; CUR_FAILURE="oracle-hardening-failed"
    fi

    if [[ -z "$FAILURE_FOUND" ]]; then
        echo "  UNCLASSIFIED: Run debug.sh for deep analysis:"
        CUR_FAILURE="unclassified"
    fi

    echo ""
    echo "  Deep dive: ./scripts/debug.sh '$PROBLEM' --full-transcript"
fi

# ── Current run stats ───────────────────────────────────────────────────────

CUR_CALLS=$(grep -c "RAW RESPONSE" "$LOG_FILE" 2>/dev/null || echo "0")
CUR_TOKENS=$(grep "tokens:" "$LOG_FILE" 2>/dev/null | grep -oP '=\s*\K\d+' | paste -sd+ 2>/dev/null | bc 2>/dev/null || echo "0")
CUR_FAILURE="${CUR_FAILURE:-}"  # set by failure analysis above, empty if passed

# ── Save state for next run ─────────────────────────────────────────────────

DEVPASSED="$([[ "$PIPELINE_PASSED" == "True" ]] && echo "True" || echo "False")" \
DEVPROBLEM="$PROBLEM" \
DEVFAILURE="${CUR_FAILURE:-}" \
DEVCALLS="$CUR_CALLS" \
DEVTOKENS="$CUR_TOKENS" \
DEVDURATION="$DURATION" \
python3 -c "
import json, os
state = {
    'problem': os.environ['DEVPROBLEM'],
    'passed': os.environ['DEVPASSED'] == 'True',
    'failure': os.environ.get('DEVFAILURE', ''),
    'calls': int(os.environ.get('DEVCALLS', '0')),
    'tokens': int(os.environ.get('DEVTOKENS', '0')),
    'duration': int(os.environ.get('DEVDURATION', '0'))
}
with open('/tmp/truth-engine-dev-state.json', 'w') as f:
    json.dump(state, f)
" 2>/dev/null || true

# ── Comparison with previous run ────────────────────────────────────────────

if [[ -n "$PREV_SAME_PROBLEM" ]]; then
    echo ""
    echo "── Comparison with previous run ──"

    # Result change
    if [[ "$PIPELINE_PASSED" == "True" && "$PREV_PASSED" == "False" ]]; then
        echo "  Result: FAIL → PASS  (fixed!)"
    elif [[ "$PIPELINE_PASSED" != "True" && "$PREV_PASSED" != "False" ]]; then
        echo "  Result: PASS → FAIL  (regression — investigate!)"
    elif [[ "$PIPELINE_PASSED" == "True" && "$PREV_PASSED" != "False" ]]; then
        echo "  Result: PASS → PASS  (still passing)"
    else
        echo "  Result: FAIL → FAIL  (not yet fixed)"
        if [[ -n "$CUR_FAILURE" && -n "$PREV_FAILURE" && "$CUR_FAILURE" != "$PREV_FAILURE" ]]; then
            echo "  Failure mode changed: $PREV_FAILURE → $CUR_FAILURE"
        fi
    fi

    # Efficiency deltas
    CALL_DELTA=$(( CUR_CALLS - PREV_CALLS ))
    TOKEN_DELTA=$(( CUR_TOKENS - PREV_TOKENS ))
    if [[ $CALL_DELTA -ne 0 || $TOKEN_DELTA -ne 0 ]]; then
        echo ""
        echo "  Calls:  $PREV_CALLS → $CUR_CALLS  ($( [[ $CALL_DELTA -le 0 ]] && echo "${CALL_DELTA}" || echo "+${CALL_DELTA}" ))"
        echo "  Tokens: $PREV_TOKENS → $CUR_TOKENS  ($( [[ $TOKEN_DELTA -le 0 ]] && echo "${TOKEN_DELTA}" || echo "+${TOKEN_DELTA}" ))"
        if [[ "$PIPELINE_PASSED" == "True" && "$PREV_PASSED" == "False" ]]; then
            echo "  Duration: ${DURATION}s"
        fi
    fi
fi

# ── Next steps ───────────────────────────────────────────────────────────────

echo ""
if [[ "$PIPELINE_PASSED" == "True" ]]; then
    echo "── Next ──"
    echo "  Problem PASSED. Next:"
    echo "    ./scripts/status.sh                         # Check if tier is now 100%"
    echo "    bun run src/test/benchmark.ts --failing      # Verify no regressions on other failures"
    echo "    bun run src/test/benchmark.ts                # Full benchmark"
elif [[ $EXIT_CODE -eq 0 && -z "$(grep -i 'EVENT.*FAILED\|killed\|ABORT' "$PIPE_OUT" 2>/dev/null || echo '')" ]]; then
    # Pipeline didn't error but result JSON says not solved — likely partial
    echo "── Next ──"
    echo "  Pipeline completed but problem not fully solved."
    echo "    ./scripts/debug.sh '$PROBLEM' --full-transcript  # See what happened turn-by-turn"
else
    echo "── Next ──"
    echo "  Fix the failure, then re-run:"
    echo "    ./scripts/dev.sh '$PROBLEM'                      # Re-test after fix"
    echo "    ./scripts/debug.sh '$PROBLEM' --full-transcript  # Deep dive if stuck"
    echo "    bun run src/test/benchmark.ts --failing          # After fix, check all failures"
fi

exit $EXIT_CODE
