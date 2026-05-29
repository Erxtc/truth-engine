#!/usr/bin/env bash
# Deep failure analysis for truth-engine runs.
# Usage:
#   ./scripts/debug.sh                     # Analyze latest log
#   ./scripts/debug.sh fibonacci           # Analyze latest log for problem matching "fibonacci"
#   ./scripts/debug.sh --full-transcript    # Show every turn's observation in full
#   ./scripts/debug.sh --actions-only       # Just agent actions + outcomes (no prompts)
#   ./scripts/debug.sh --oracle             # Show oracle source from the log
#   ./scripts/debug.sh -t                   # Token usage + call timeline
#
# Goes beyond logs.sh -e (errors) and provides turn-by-turn analysis
# of what the model DID, what it SAW, and WHY it failed.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"
cd "$ROOT"

LOG_DIR="$ROOT/logs"
LOG_GLOB="$LOG_DIR/truth-engine-*.log"

# ── Parse args ──────────────────────────────────────────────────────────────

MODE="timeline"
PROBLEM_FILTER=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --full-transcript) MODE="full"; shift ;;
        --actions-only)    MODE="actions"; shift ;;
        --oracle)          MODE="oracle"; shift ;;
        -t|--tokens)       MODE="tokens"; shift ;;
        -h|--help)
            echo "Usage: ./scripts/debug.sh [PROBLEM_FILTER] [--full-transcript|--actions-only|--oracle|-t]"
            echo ""
            echo "  PROBLEM_FILTER        Substring match against log content (e.g. 'glycolysis')"
            echo "  --full-transcript      Show every turn's observation in full"
            echo "  --actions-only         Just agent actions + outcomes"
            echo "  --oracle               Show oracle source from log"
            echo "  -t, --tokens           Token usage timeline"
            echo ""
            echo "Examples:"
            echo "  ./scripts/debug.sh                               # Latest run timeline"
            echo "  ./scripts/debug.sh glycolysis --full-transcript   # Deep dive on glycolysis failure"
            echo "  ./scripts/debug.sh sorting --actions-only         # What did the agent do?"
            exit 0
            ;;
        *) PROBLEM_FILTER="$PROBLEM_FILTER $1"; shift ;;
    esac
done

PROBLEM_FILTER="${PROBLEM_FILTER# }"

# ── Find log ────────────────────────────────────────────────────────────────

LOGS=($(ls -t $LOG_GLOB 2>/dev/null | grep -v '\.full\.log$' || true))
if [[ ${#LOGS[@]} -eq 0 ]]; then
    echo "No log files found in $LOG_DIR"
    exit 1
fi

FILE=""
if [[ -n "$PROBLEM_FILTER" ]]; then
    for f in "${LOGS[@]}"; do
        if grep -qFi "$PROBLEM_FILTER" "$f" 2>/dev/null; then
            FILE="$f"
            break
        fi
    done
    if [[ -z "$FILE" ]]; then
        echo "No log matching '$PROBLEM_FILTER' found."
        echo "Recent logs:"
        for i in "${!LOGS[@]}"; do echo "  $i: $(basename "${LOGS[$i]}")"; done | head -10
        exit 1
    fi
    echo "═══ $(basename "$FILE") (matched: '$PROBLEM_FILTER') ═══"
else
    FILE="${LOGS[0]}"
    echo "═══ $(basename "$FILE") (latest) ═══"
fi

echo ""

# ── Token timeline ──────────────────────────────────────────────────────────

if [[ "$MODE" == "tokens" || "$MODE" == "timeline" || "$MODE" == "full" ]]; then
    echo "── LLM calls ──"
    if ! grep -q "^\[.*\] CALL #" "$FILE" 2>/dev/null; then
        echo "  No LLM calls found in this log."
    else
        grep -n "^\[.*\] CALL #\|── STATUS:" "$FILE" 2>/dev/null | while IFS= read -r line; do
            if [[ "$line" =~ CALL\ #([0-9]+).*role=([a-z-]+).*model=([a-z-]+) ]]; then
                printf "  #%-3s %-16s %-16s" "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}" "${BASH_REMATCH[3]}"
            elif [[ "$line" =~ STATUS:.*tokens:\ ([0-9]+)p\ \+\ ([0-9]+)c\ =\ ([0-9]+) ]]; then
                printf "  %4sp + %4sc = %5stk\n" "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}" "${BASH_REMATCH[3]}"
            fi
        done
    fi
    echo ""
fi

# ── Oracle source ───────────────────────────────────────────────────────────

if [[ "$MODE" == "oracle" ]]; then
    echo "── Oracle ──"
    ORACLE=$(grep '"oracle_js"' "$FILE" 2>/dev/null | tail -1 || echo "")
    if [[ -z "$ORACLE" ]]; then
        echo "  No oracle found in this log."
    else
        # Extract just the JS function
        echo "$ORACLE" | python3 -c "
import sys, json, re
line = sys.stdin.read().strip()
# The oracle_js is embedded in a larger JSON line — find it
m = re.search(r'\"oracle_js\":\s*\"(.+?)\"\s*[,}]', line)
if m:
    js = m.group(1)
    js = js.replace('\\\\n', '\n').replace('\\\\t', '    ').replace('\\\"', '\"').replace('\\\\', '\\\\')
    # Pretty-print with basic indentation
    for line in js.split('\n'):
        stripped = line.strip()
        if stripped:
            print(f'  {stripped}')
else:
    print('  (could not parse oracle JS)')
" 2>/dev/null || echo "$ORACLE" | head -c 2000
    fi
    echo ""
fi

# ── Pipeline stages ─────────────────────────────────────────────────────────

if [[ "$MODE" == "timeline" || "$MODE" == "full" ]]; then
    echo "── Pipeline ──"
    EVENTS=$(grep "EVENT\|✓ SOLVED\|✗ FAILED" "$FILE" 2>/dev/null || echo "")
    if [[ -z "$EVENTS" ]]; then
        echo "  (no pipeline events found)"
    else
        echo "$EVENTS" | while IFS= read -r line; do
            echo "  $line" | sed 's/.*EVENT/EVENT/' | sed 's/.*✓/✓/' | sed 's/.*✗/✗/'
        done
    fi
    echo ""
fi

# ── Agent actions ───────────────────────────────────────────────────────────

if [[ "$MODE" == "actions" || "$MODE" == "full" ]]; then
    echo "── Agent actions ──"
    ACTIONS=$(grep -n "Turn\|Action:\|Auto-finish\|REMINDER\|WARNING\|stuck\|STAGNATION\|LOOP\|terminated\|TERMINATED\|zoom\|ZOOM" "$FILE" 2>/dev/null || echo "")
    if [[ -z "$ACTIONS" ]]; then
        echo "  (no agent actions found — 1-shot pass or log from simple run)"
    else
        echo "$ACTIONS" | while IFS= read -r line; do
            if [[ "$line" =~ Turn\ ([0-9]+)/([0-9]+) ]]; then
                echo ""
                echo "  ── Turn ${BASH_REMATCH[1]}/${BASH_REMATCH[2]} ──"
            elif [[ "$line" =~ Action:\ (.*) ]]; then
                ACTION="${BASH_REMATCH[1]}"
                if [[ ${#ACTION} -gt 120 ]]; then
                    ACTION="${ACTION:0:117}..."
                fi
                echo "    → $ACTION"
            elif [[ "$line" =~ Auto-finish ]]; then
                echo "    ⚡ Auto-finish triggered"
            elif [[ "$line" =~ REMINDER ]]; then
                MSG=$(echo "$line" | sed 's/.*REMINDER://')
                echo "    ⚠ REMINDER: ${MSG:0:100}"
            elif [[ "$line" =~ WARNING ]]; then
                MSG=$(echo "$line" | sed 's/.*WARNING://')
                echo "    ⛔ WARNING: ${MSG:0:100}"
            elif [[ "$line" =~ (stuck|STAGNATION|LOOP|terminated|TERMINATED|zoom|ZOOM) ]]; then
                echo "    🔴 $line" | sed 's/^[0-9]*://'
            fi
        done
    fi
    echo ""
fi

# ── Full transcript ─────────────────────────────────────────────────────────

if [[ "$MODE" == "full" ]]; then
    echo "── Observations ──"
    echo ""
    grep -n "observation\|── RAW RESPONSE\|Error:" "$FILE" 2>/dev/null | head -200 | while IFS= read -r line; do
        if [[ "$line" =~ RAW\ RESPONSE ]]; then
            echo "  ── Model response ──"
        elif [[ "$line" =~ observation ]]; then
            OBS=$(echo "$line" | sed 's/.*"observation":"//' | sed 's/","role".*//' 2>/dev/null || echo "$line")
            if [[ -n "$OBS" && ${#OBS} -gt 10 ]]; then
                echo "  📋 ${OBS:0:400}"
                if [[ ${#OBS} -gt 400 ]]; then
                    echo "     ... (${#OBS} chars total)"
                fi
                echo ""
            fi
        elif [[ "$line" =~ Error: ]]; then
            echo "  ❌ $line" | sed 's/^[0-9]*://'
        fi
    done
    echo ""
fi

# ── Root cause ──────────────────────────────────────────────────────────────

if [[ "$MODE" == "timeline" || "$MODE" == "full" || "$MODE" == "actions" ]]; then
    echo "── Root cause ──"

    # Solved?
    if grep -qi "✓ SOLVED" "$FILE" 2>/dev/null; then
        HOW=$(grep -i "✓ SOLVED\|EVENT.*✓ SOLVED" "$FILE" 2>/dev/null | tail -1)
        CALLS=$(grep -c "^\[.*\] CALL #" "$FILE" 2>/dev/null || echo "?")
        echo "  ✅ SOLVED — $HOW  (${CALLS// /} calls)"
    fi

    # Self-termination
    if grep -qi "TERMINATED:\|FAILURE STORM\|LOOP DETECTED:\|STAGNATION DETECTED:\|ERROR LOOP" "$FILE" 2>/dev/null; then
        REASON=$(grep -i "TERMINATED:\|FAILURE STORM\|LOOP DETECTED:\|STAGNATION DETECTED:\|ERROR LOOP" "$FILE" 2>/dev/null | tail -1)
        echo "  🔴 SELF-TERMINATED: $REASON"
        echo "     → Model repeated same actions without progress"
        echo "     → Fix: simplify workflow, check if oracle/commands are working"
    fi

    # Supervisor abort
    if grep -qi "ABORTED\|supervisor.*abort" "$FILE" 2>/dev/null; then
        echo "  🟡 SUPERVISOR ABORT: model couldn't make progress"
        echo "     → Try different problem formulation or domain"
    fi

    # Supervisor exhausted
    if grep -qi "supervisor loop exhausted\|exhausted supervisor" "$FILE" 2>/dev/null; then
        echo "  🟡 SUPERVISOR EXHAUSTED: 2 retry iterations, neither passed"
        echo "     → Check specific oracle failures to understand what went wrong"
    fi

    # Stub output
    FAIL_COUNT=$(grep -ci "FAILED.*expected\|oracle.*FAIL" "$FILE" 2>/dev/null || echo "0")
    PASS_COUNT=$(grep -ci "PASS.*expected\|oracle.*PASS" "$FILE" 2>/dev/null || echo "0")
    if [[ "$FAIL_COUNT" -ge 3 && "$PASS_COUNT" -eq 0 ]]; then
        echo "  🟡 ALL TESTS FAILING: $FAIL_COUNT failures, 0 passes"
        echo "     → Likely stub output (return 0/None/[]) or wrong function signature"
    fi

    # Premature finish
    if grep -qi "finish.*without.*test\|finish.*before.*pass\|not.*all.*pass.*finish" "$FILE" 2>/dev/null; then
        echo "  🟡 PREMATURE FINISH: called finish() before verification passed"
    fi

    # Parse failures
    PARSE=$(grep -ci "No valid Action\|invalid action\|could not produce a valid" "$FILE" 2>/dev/null || echo "0")
    if [[ "$PARSE" -ge 1 ]]; then
        echo "  🟡 PARSE FAILURE: $PARSE time(s) — model output couldn't be parsed"
    fi
fi

echo ""
echo "──────────────────────────────────────────────────────────────────"
echo "  Quick commands:"
echo "    ./scripts/logs.sh -e     Errors from latest log"
echo "    ./scripts/logs.sh -a     Agent actions (turn-by-turn)"
echo "    ./scripts/logs.sh -c     Compare last two runs"
echo "    ./scripts/dev.sh '<problem>'   Re-run a specific problem"
echo "──────────────────────────────────────────────────────────────────"
