#!/usr/bin/env bash
# Quick log inspection for truth-engine runs.
# Usage:
#   ./scripts/logs.sh              — latest log summary
#   ./scripts/logs.sh -f            — follow latest log (tail -f)
#   ./scripts/logs.sh -e            — show errors only
#   ./scripts/logs.sh -o            — show oracle results
#   ./scripts/logs.sh -a            — show all agent actions (turn-by-turn)
#   ./scripts/logs.sh -p            — show prompts (what the model saw)
#   ./scripts/logs.sh N             — show log #N (latest = no arg, or use index)
#   ./scripts/logs.sh -t            — show token usage across all calls
#   ./scripts/logs.sh -c            — compare last two runs side-by-side
#   ./scripts/logs.sh -j            — JSON output (machine-readable, for agents)
#   ./scripts/logs.sh -l            — list all log files with LLM call counts
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"
cd "$ROOT"

# Logs live in logs/ (prompt-logger.ts) with a latest.log symlink in root
LOG_DIR="$ROOT/logs"
if [[ -d "$LOG_DIR" ]]; then
    LOG_GLOB="$LOG_DIR/truth-engine-*.log"
else
    LOG_GLOB="truth-engine-*.log"
fi

# ── helpers ────────────────────────────────────────────────────────────────────

llm_calls()  { grep -c "RAW RESPONSE" "$1" 2>/dev/null || echo "0"; }
total_tokens() {
    grep "tokens:" "$1" 2>/dev/null | grep -oP '=\s*\K\d+' | paste -sd+ | bc 2>/dev/null || echo "0"
}
total_cost() {
    grep "cost:" "$1" 2>/dev/null | grep -oP '\$\K[\d.]+' | paste -sd+ | bc 2>/dev/null || echo "0"
}
pass_fail()  {
    if   grep -q "EVENT.*✓ SOLVED\|PROBLEM SOLVED\|FINAL ANSWER\|all tests passed\|\"solved\":true" "$1" 2>/dev/null; then echo "PASS";
    elif grep -q "EVENT.*✗ FAILED\|✗.*killed\|No solution\|all.*failed\|ABORT\|\"solved\":false" "$1" 2>/dev/null; then echo "FAIL";
    # Fall back to oracle results for benchmark subprocess runs (no EVENT markers)
    elif grep -q "oracle.*PASS\|oracle.*Passed\|all tests passed" "$1" 2>/dev/null; then echo "PASS";
    elif grep -q "oracle.*FAIL\|oracle.*Failed" "$1" 2>/dev/null; then echo "FAIL";
    else echo "????"; fi
}
oracle_results() {
    grep -n "oracle.*Passed\|oracle.*Failed\|oracle.*rejected\|✓.*oracle\|✗.*oracle" "$1" 2>/dev/null || echo "(none)"
}
errors_only() {
    # Strip prompt sections (── SYSTEM/USER PROMPT → ── RAW RESPONSE) and
    # parsed-JSON blocks (── PARSED JSON → ── STATUS:) before searching.
    # These contain oracle examples/code that mention "fail"/"error" as
    # test cases, not as actual failures.
    awk '
        /^── SYSTEM PROMPT/     { in_skip=1; next }
        /^── USER PROMPT/       { in_skip=1; next }
        /^── PARSED JSON/       { in_json=1; next }
        /^── STATUS: OK/        { in_json=0 }
        /^── RAW RESPONSE/      { in_skip=0; in_json=0 }
        !in_skip && !in_json
    ' "$1" 2>/dev/null | grep -n -i "── ERROR\b\|error\|exception\|failed\|killed\|abort\|stuck\|wrong\|Traceback" | grep -v "fail.*mode\|possible_failure\|const.*errors\b" || echo "(none)"
}
agent_actions() {
    grep -n "Action:\|\[task-agent\] Turn\|\[repair\]\|\[1-shot\]\|\[supervisor\]\|Inspection\|Inspector:\|Agent:" "$1" 2>/dev/null || echo "(none)"
}
prompts() {
    grep -n "USER PROMPT\|SYSTEM PROMPT\|THE ERROR:\|ORACLE\|THE BROKEN CODE" "$1" 2>/dev/null || echo "(none)"
}
duration() {
    local started ended
    started=$(head -2 "$1" | grep "Started:" | head -1 | sed 's/.*Started: //' | head -c 19)
    if [[ -n "$started" ]]; then
        local s_epoch=$(date -d "$started" +%s 2>/dev/null || echo 0)
        local mtime=$(stat -c %Y "$1" 2>/dev/null || echo 0)
        if [[ "$s_epoch" -gt 0 && "$mtime" -gt "$s_epoch" ]]; then
            echo "$(( (mtime - s_epoch) ))s"
        else
            echo "?"
        fi
    else echo "?"; fi
}

# ── main ───────────────────────────────────────────────────────────────────────

LOGS=($(ls -t $LOG_GLOB 2>/dev/null | grep -v '\.full\.log$' || true))
if [[ ${#LOGS[@]} -eq 0 ]]; then
    echo "No log files found."
    exit 1
fi

MODE="summary"
LOG_IDX=""
while [[ $# -gt 0 ]]; do
    case "$1" in
        -f) MODE="follow"; shift ;;
        -e) MODE="errors"; shift ;;
        -o) MODE="oracle"; shift ;;
        -a) MODE="actions"; shift ;;
        -p) MODE="prompts"; shift ;;
        -c) MODE="compare"; shift ;;
        -t) MODE="tokens"; shift ;;
        -j) MODE="json"; shift ;;
        -l) MODE="list"; shift ;;
        -h|--help) MODE="help"; shift ;;
        *)  LOG_IDX="$1"; shift ;;
    esac
done

if [[ "$MODE" == "help" ]]; then
    echo "Usage: ./scripts/logs.sh [OPTION] [LOG_INDEX]"
    echo ""
    echo "Options:"
    echo "  (none)   Show summary of latest log"
    echo "  -f        Follow latest log (tail -f)"
    echo "  -e        Show errors only"
    echo "  -o        Show oracle results"
    echo "  -a        Show agent actions (turn-by-turn)"
    echo "  -p        Show prompts (what the model saw)"
    echo "  -t        Show token usage across all calls"
    echo "  -c        Compare last two runs"
    echo "  -l        List all log files with summaries"
    echo "  N         Show summary of log #N (0=latest, 1=previous, etc.)"
    exit 0
fi

if [[ "$MODE" == "list" ]]; then
    printf "%-3s %-35s %5s %8s %7s %5s %s\n" "#" "FILE" "CALLS" "TOKENS" "COST" "RESULT" "TIME"
    for i in "${!LOGS[@]}"; do
        f="${LOGS[$i]}"
        calls=$(llm_calls "$f")
        tokens=$(total_tokens "$f")
        cost=$(total_cost "$f")
        result=$(pass_fail "$f")
        dur=$(duration "$f")
        cost_fmt=""
        if [[ "$cost" != "0" && -n "$cost" ]]; then
            cost_fmt=$(printf "\$%.2f" "$cost")
        fi
        printf "%-3s %-35s %5s %8s %7s %5s %s\n" "$i" "$(basename "$f")" "$calls" "$tokens" "${cost_fmt:-}" "$result" "$dur"
    done
    exit 0
fi

if [[ "$MODE" == "json" ]]; then
    IDX="${LOG_IDX:-0}"
    F="${LOGS[$IDX]:-${LOGS[0]}}"
    calls=$(llm_calls "$F")
    tokens=$(total_tokens "$F")
    cost=$(total_cost "$F")
    result=$(pass_fail "$F")
    dur=$(duration "$F")
    echo "{"
    echo "  \"file\": \"$(basename "$F")\","
    echo "  \"calls\": $calls,"
    echo "  \"totalTokens\": $tokens,"
    echo "  \"totalCost\": $cost,"
    echo "  \"result\": \"$result\","
    echo "  \"duration\": \"$dur\""
    echo "}"
    exit 0
fi

if [[ "$MODE" == "follow" ]]; then
    exec tail -f "${LOGS[0]}"
fi

# Pick log file
IDX="${LOG_IDX:-0}"
FILE="${LOGS[$IDX]:-${LOGS[0]}}"
if [[ ! -f "$FILE" ]]; then
    echo "Log #$IDX not found."
    exit 1
fi

if [[ "$MODE" == "compare" ]]; then
    F0="${LOGS[0]}"
    F1="${LOGS[1]:-}"
    if [[ -z "$F1" ]]; then echo "Need at least 2 logs to compare."; exit 1; fi

    C0=$(llm_calls "$F0")
    C1=$(llm_calls "$F1")
    R0=$(pass_fail "$F0")
    R1=$(pass_fail "$F1")
    T0=$(total_tokens "$F0")
    T1=$(total_tokens "$F1")
    CO0=$(total_cost "$F0")
    CO1=$(total_cost "$F1")
    D0=$(duration "$F0")
    D1=$(duration "$F1")

    # Format cost strings
    cost0=""; cost1=""
    [[ -n "$CO0" && "$CO0" != "0" ]] && cost0=$(printf "\$%.4f" "$CO0")
    [[ -n "$CO1" && "$CO1" != "0" ]] && cost1=$(printf "\$%.4f" "$CO1")

    echo "═══ LATEST: $(basename "$F0") ═══"
    echo "  Calls: $C0  Tokens: $T0  Cost: ${cost0:-$0}  Result: $R0  Time: $D0"
    echo "═══ PREV:   $(basename "$F1") ═══"
    echo "  Calls: $C1  Tokens: $T1  Cost: ${cost1:-$0}  Result: $R1  Time: $D1"
    echo ""

    # Directional comparison
    CALL_DELTA=$(( C0 - C1 ))
    TOKEN_DELTA=$(( T0 - T1 ))
    COST_DELTA=$(echo "$CO0 - $CO1" | bc 2>/dev/null || echo "0")
    COST_DELTA_NEG=$(echo "$COST_DELTA < 0" | bc 2>/dev/null || echo "0")
    COST_DELTA_ABS=$(echo "if ($COST_DELTA < 0) -$COST_DELTA else $COST_DELTA" | bc 2>/dev/null || echo "0")
    if [[ $(echo "$COST_DELTA_ABS > 0.0001 || $TOKEN_DELTA < 0 || ($TOKEN_DELTA > 0 && $TOKEN_DELTA > 100) || $CALL_DELTA != 0" | bc 2>/dev/null) -eq 1 || $(( TOKEN_DELTA < 0 ? -TOKEN_DELTA : TOKEN_DELTA )) -gt 100 || $CALL_DELTA -ne 0 ]]; then
        echo "── Delta ──"
        if [[ $CALL_DELTA -lt 0 ]]; then
            echo "  Calls: ${CALL_DELTA} (more efficient)"
        elif [[ $CALL_DELTA -gt 0 ]]; then
            echo "  Calls: +${CALL_DELTA} (more calls — investigate if result unchanged)"
        else
            echo "  Calls: same"
        fi
        if [[ $TOKEN_DELTA -lt 0 ]]; then
            echo "  Tokens: ${TOKEN_DELTA} (cheaper)"
        elif [[ $TOKEN_DELTA -gt 0 ]]; then
            echo "  Tokens: +${TOKEN_DELTA} (more expensive)"
        else
            echo "  Tokens: same"
        fi
        if [[ "$COST_DELTA_NEG" == "1" ]]; then
            echo "  Cost: -${COST_DELTA_ABS} (cheaper)"
        elif [[ $(echo "$COST_DELTA > 0.0001" | bc 2>/dev/null) == "1" ]]; then
            echo "  Cost: +\$$(printf "%.4f" "$COST_DELTA") (more expensive)"
        else
            echo "  Cost: same"
        fi
    fi

    if [[ "$R0" != "$R1" ]]; then
        echo ""
        if [[ "$R0" == "PASS" && "$R1" == "FAIL" ]]; then
            echo "  Result: FAIL → PASS (fixed!)"
        elif [[ "$R0" == "FAIL" && "$R1" == "PASS" ]]; then
            echo "  Result: PASS → FAIL (regression!)"
        fi
    fi
    exit 0
fi

# ── summary ────────────────────────────────────────────────────────────────────

CALLS=$(llm_calls "$FILE")
TOKENS=$(total_tokens "$FILE")
COST=$(total_cost "$FILE")
RESULT=$(pass_fail "$FILE")
DUR=$(duration "$FILE")
COST_FMT=""
[[ -n "$COST" && "$COST" != "0" ]] && COST_FMT=$(printf "   Cost: \$%.4f" "$COST")
echo "═══ $(basename "$FILE") ═══"
echo "  LLM calls: $CALLS   Tokens: $TOKENS${COST_FMT}   Result: $RESULT   Duration: $DUR"
echo ""

if [[ "$MODE" == "errors" ]]; then
    echo "── ERRORS ──"
    errors_only "$FILE"
elif [[ "$MODE" == "oracle" ]]; then
    echo "── ORACLE RESULTS ──"
    oracle_results "$FILE"
elif [[ "$MODE" == "actions" ]]; then
    echo "── AGENT ACTIONS ──"
    agent_actions "$FILE"
elif [[ "$MODE" == "prompts" ]]; then
    echo "── KEY PROMPTS ──"
    prompts "$FILE"
elif [[ "$MODE" == "tokens" ]]; then
    echo "── TOKEN USAGE (per call) ──"
    grep -n "CALL #" "$FILE" 2>/dev/null
    echo ""
    grep -n "tokens:" "$FILE" 2>/dev/null || echo "No token data found"
else
    echo "── ORACLE ──"
    oracle_results "$FILE" | tail -10
    echo ""
    echo "── ERRORS ──"
    errors_only "$FILE" | tail -10
    echo ""
    echo "── ACTIONS ──"
    agent_actions "$FILE" | tail -15
fi
