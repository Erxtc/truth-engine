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
        --json)            MODE="json"; shift ;;
        -h|--help)
            echo "Usage: ./scripts/debug.sh [PROBLEM_FILTER] [--full-transcript|--actions-only|--oracle|-t|--json]"
            echo ""
            echo "  PROBLEM_FILTER        Substring match against log content (e.g. 'glycolysis')"
            echo "  --full-transcript      Show every turn's observation in full"
            echo "  --actions-only         Just agent actions + outcomes"
            echo "  --oracle               Show oracle source from log"
            echo "  -t, --tokens           Token usage timeline"
            echo "  --json                 Machine-readable JSON failure analysis"
            echo ""
            echo "Examples:"
            echo "  ./scripts/debug.sh                               # Latest run timeline"
            echo "  ./scripts/debug.sh glycolysis --full-transcript   # Deep dive on glycolysis failure"
            echo "  ./scripts/debug.sh sorting --actions-only         # What did the agent do?"
            echo "  ./scripts/debug.sh --json                         # Structured failure analysis"
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

# ── JSON mode (machine-readable failure analysis) ───────────────────────────

if [[ "$MODE" == "json" ]]; then
    export DEBUG_LOG_FILE="$FILE"
    python3 << 'PYEOF'
import json, re, os, sys

logfile = os.environ.get("DEBUG_LOG_FILE", "")
if not logfile:
    print(json.dumps({"error": "no log file found"}))
    sys.exit(0)

with open(logfile) as f:
    content = f.read()

# ── Helpers ──
def safe_grep(pattern, text):
    return [m for m in re.finditer(pattern, text, re.IGNORECASE)]

def grep_count(pattern, text):
    return len(re.findall(pattern, text, re.IGNORECASE))

# ── Basic stats ──
calls = grep_count(r"RAW RESPONSE", content)
tokens_match = re.findall(r"=\s*(\d+)", "\n".join(re.findall(r"tokens:.*", content)))
total_tokens = sum(int(t) for t in tokens_match) if tokens_match else 0
cost_match = re.findall(r"cost:\s*\$?([\d.]+)", content, re.IGNORECASE)
total_cost = sum(float(c) for c in cost_match) if cost_match else 0.0

# Duration
started_m = re.search(r"Started:\s*(\S+)", content)
duration_s = None
if started_m:
    import subprocess
    try:
        s = subprocess.check_output(["date", "-d", started_m.group(1), "+%s"], text=True).strip()
        m = subprocess.check_output(["stat", "-c", "%Y", logfile], text=True).strip()
        if s and m:
            duration_s = int(m) - int(s)
    except:
        pass

# ── Result ──
solved = bool(re.search(r"EVENT.*SOLVED|all tests passed", content, re.IGNORECASE))
if not solved:
    solved = bool(re.search(r'"solved":\s*true', content, re.IGNORECASE))

# ── Pipeline stages ──
stages = []
for m in re.finditer(r"(?:EVENT|✓|✗)\s*(.*?)(?:\n|$)", content):
    stages.append(m.group(0).strip())

# ── Agent actions ──
actions = []
for m in re.finditer(r"\[task-agent\] Turn (\d+)/(\d+)", content):
    actions.append({"turn": int(m.group(1)), "maxTurns": int(m.group(2)), "type": "turn_start"})
for m in re.finditer(r"Action:\s*(.*?)(?:\n|$)", content):
    action = m.group(1).strip()
    # Truncate if very long
    if len(action) > 200:
        action = action[:197] + "..."
    actions.append({"type": "action", "detail": action})
for m in re.finditer(r"Auto-finish", content):
    actions.append({"type": "auto_finish"})
for m in re.finditer(r"(?:ZOOM OUT|LOOP DETECTED|STAGNATION|TERMINATED|FAILURE STORM)[:\s]*(.*?)(?:\n|$)", content):
    actions.append({"type": "termination", "reason": m.group(0).strip()})

# ── LLM calls ──
llm_calls = []
for m in re.finditer(r"CALL #(\d+)\s+role=(\S+)\s+model=(\S+)", content):
    llm_calls.append({"num": int(m.group(1)), "role": m.group(2), "model": m.group(3)})
for i, m in enumerate(re.finditer(r"tokens:\s*(\d+)p\s*\+\s*(\d+)c\s*=\s*(\d+)", content)):
    if i < len(llm_calls):
        llm_calls[i]["promptTokens"] = int(m.group(1))
        llm_calls[i]["completionTokens"] = int(m.group(2))
        llm_calls[i]["totalTokens"] = int(m.group(3))
# Cost per call
for i, m in enumerate(re.finditer(r"cost:\s*\$?([\d.]+)", content, re.IGNORECASE)):
    if i < len(llm_calls):
        llm_calls[i]["cost"] = float(m.group(1))

# ── Errors ──
# Strip prompt sections like logs.sh -e does
lines = content.split("\n")
stripped_lines = []
in_skip = False
in_json_block = False
for line in lines:
    if line.startswith("── SYSTEM PROMPT") or line.startswith("── USER PROMPT"):
        in_skip = True
        continue
    if line.startswith("── PARSED JSON"):
        in_json_block = True
        continue
    if "── STATUS: OK" in line:
        in_json_block = False
    if "── RAW RESPONSE" in line:
        in_skip = False
        in_json_block = False
    if not in_skip and not in_json_block:
        stripped_lines.append(line)

stripped = "\n".join(stripped_lines)
errors = []
for m in re.finditer(r"── ERROR\b.*?(?:\n|$)", stripped, re.IGNORECASE):
    errors.append(m.group(0).strip())
for m in re.finditer(r"(?:Error|error|Traceback|Exception)[:\s].*?(?:\n|$)", stripped):
    err = m.group(0).strip()
    # Filter out oracle test content
    if "possible_failure" not in err.lower() and "fail.*mode" not in err.lower():
        if len(err) > 200:
            err = err[:197] + "..."
        errors.append(err)

# Deduplicate while preserving order
seen = set()
unique_errors = []
for e in errors:
    key = e[:80]
    if key not in seen:
        seen.add(key)
        unique_errors.append(e)

# ── Failure classification ──
failure = None
if re.search(r"ZOOM OUT|LOOP DETECTED|STAGNATION DETECTED|terminated.*loop|same action.*3", content, re.IGNORECASE):
    failure = "stuck-loop"
elif re.search(r"finish.*without.*test|finish.*before.*pass|not.*all.*pass.*finish", content, re.IGNORECASE):
    failure = "premature-finish"
elif re.search(r"No valid Action|invalid action|could not produce a valid|parse.*fail", content, re.IGNORECASE):
    failure = "parse-failure"
elif re.search(r"max.*turns|budget.*exhaust|turn.*limit|auto-finish", content, re.IGNORECASE):
    failure = "budget-exhausted"
elif re.search(r"TERMINATED:|FAILURE STORM", content):
    failure = "failure-storm"
elif re.search(r"ABORTED|supervisor.*abort", content, re.IGNORECASE):
    failure = "supervisor-abort"
elif re.search(r"supervisor loop exhausted|exhausted supervisor", content, re.IGNORECASE):
    failure = "supervisor-exhausted"
elif re.search(r"oracle.*hardening.*fail|weak oracle|broken stub", content, re.IGNORECASE):
    failure = "oracle-hardening-failed"

# All-tests-failing check
fail_count = len(re.findall(r"FAILED.*expected|oracle.*FAIL|✗ FAILED", content, re.IGNORECASE))
pass_count = len(re.findall(r"PASS.*expected|oracle.*PASS|✓ PASS", content, re.IGNORECASE))
if fail_count >= 3 and pass_count == 0 and not failure:
    failure = "all-tests-failing"

# ── Oracle results ──
oracle_results = []
for m in re.finditer(r"oracle.*?(?:PASS|FAIL|Passed|Failed)[:\s]*(.*?)(?:\n|$)", content, re.IGNORECASE):
    oracle_results.append(m.group(0).strip())

# ── Solved by ──
solved_by = None
if solved:
    for pattern, by in [
        (r"1-shot baseline", "1-shot"),
        (r"SOLVED.*repair", "repair"),
        (r"SOLVED.*task-agent", "task-agent"),
        (r"SOLVED.*supervisor", "supervisor-retry"),
    ]:
        if re.search(pattern, content, re.IGNORECASE):
            solved_by = by
            break

# ── Build output ──
output = {
    "logFile": os.path.basename(logfile),
    "solved": solved,
    "solvedBy": solved_by,
    "failure": failure,
    "calls": calls,
    "totalTokens": total_tokens,
    "totalCost": round(total_cost, 6),
    "durationSeconds": duration_s,
    "pipelineStages": stages[-10:] if len(stages) > 10 else stages,
    "actions": actions,
    "llmCalls": llm_calls,
    "errors": unique_errors[-15:],
    "oracleResults": oracle_results[-10:],
    "failureStats": {
        "failCount": fail_count,
        "passCount": pass_count,
    },
}

print(json.dumps(output, indent=2))
PYEOF
    exit 0
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
        echo "  🔴 STUCK LOOP: $REASON"
        echo "     → Model repeated same actions without progress"
        echo "     → CHECK: Run 'node oracle.js solution.py' — is the oracle working?"
        echo "     → CHECK: Are error messages actionable? Can the model understand them?"
        echo "     → FIX: Simplify the workflow; add domain knowledge to prompt; reduce complexity"
        echo "     → FIX: Check if the model is receiving the oracle output correctly"
    fi

    # Supervisor abort
    if grep -qi "ABORTED\|supervisor.*abort" "$FILE" 2>/dev/null; then
        echo "  🟡 SUPERVISOR ABORT: model couldn't make progress"
        echo "     → CHECK: Read the oracle errors — what did the model get wrong?"
        echo "     → FIX: Try different problem formulation, domain, or add domain invariants"
        echo "     → FIX: The problem may need domain-specific knowledge in the prompt"
    fi

    # Supervisor exhausted
    if grep -qi "supervisor loop exhausted\|exhausted supervisor" "$FILE" 2>/dev/null; then
        echo "  🟡 SUPERVISOR EXHAUSTED: 2 retry iterations, neither passed"
        echo "     → CHECK: Specific oracle failures — is the model getting closer or further?"
        echo "     → FIX: If getting closer, increase retry iterations"
        echo "     → FIX: If oscillating, the supervisor needs better direction hints"
    fi

    # Stub output
    FAIL_COUNT=$(grep -ci "FAILED.*expected\|oracle.*FAIL" "$FILE" 2>/dev/null || echo "0")
    PASS_COUNT=$(grep -ci "PASS.*expected\|oracle.*PASS" "$FILE" 2>/dev/null || echo "0")
    if [[ "$FAIL_COUNT" -ge 3 && "$PASS_COUNT" -eq 0 ]]; then
        echo "  🟡 ALL TESTS FAILING: $FAIL_COUNT failures, 0 passes"
        echo "     → Likely stub output (return 0/None/[]) or wrong function signature"
        echo "     → CHECK: What does the model's code actually return?"
        echo "     → FIX: Harden the oracle to reject trivial returns (0, None, [], '')"
        echo "     → FIX: Check if the function signature matches what the oracle expects"
    fi

    # Premature finish
    if grep -qi "finish.*without.*test\|finish.*before.*pass\|not.*all.*pass.*finish" "$FILE" 2>/dev/null; then
        echo "  🟡 PREMATURE FINISH: called finish() before verification passed"
        echo "     → FIX: Prompt must explicitly say 'MUST see all tests pass before finish()'"
        echo "     → FIX: Add a guard that rejects finish() when oracle hasn't been run"
    fi

    # Parse failures
    PARSE=$(grep -ci "No valid Action\|invalid action\|could not produce a valid" "$FILE" 2>/dev/null || echo "0")
    if [[ "$PARSE" -ge 1 ]]; then
        echo "  🟡 PARSE FAILURE: $PARSE time(s) — model output couldn't be parsed"
        echo "     → CHECK: Did the model output bold/code-fence wrapped actions? (parser handles these)"
        echo "     → FIX: Check task-agent-prompt.ts — is the action format clear and unambiguous?"
        echo "     → FIX: Add action format examples to the system prompt"
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
