#!/usr/bin/env bash
# Status dashboard — one command to see everything.
# Usage: ./scripts/status.sh
#
# Shows: git state, benchmark history, efficiency trend, recent run
# history, token usage, and what's currently failing.
#
# Designed to be agent-friendly: all state is read-only, never fails
# (degradation is graceful), and output is structured for quick scanning.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"
cd "$ROOT"

BOLD="\033[1m"
DIM="\033[2m"
GREEN="\033[32m"
YELLOW="\033[33m"
RED="\033[31m"
CYAN="\033[36m"
RESET="\033[0m"
BAR="══════════════════════════════════════════════════════════════════"

# Helper: safe grep that returns empty string on no match (no pipefail issues)
safe_grep() { grep "$@" 2>/dev/null || true; }
safe_grep_count() { grep -c "$@" 2>/dev/null || echo "0"; }

# ── 0. Header ──────────────────────────────────────────────────────────────────

echo -e "${BOLD}${BAR}"
echo "  STATUS DASHBOARD"
echo -e "${BAR}${RESET}"

# ── 1. Git status ──────────────────────────────────────────────────────────────

echo ""
echo -e "${BOLD}── GIT ───────────────────────────────────────────────────────────────${RESET}"
BRANCH=$(git branch --show-current 2>/dev/null || echo "?")
COMMIT=$(git log --oneline -1 2>/dev/null || echo "?")
CHANGES=$(safe_grep_count "" <<< "$(git status --short 2>/dev/null)")
AHEAD=$(git rev-list --count origin/"$BRANCH"..HEAD 2>/dev/null || echo "0")
echo -e "  Branch:     ${CYAN}$BRANCH${RESET}"
echo -e "  Last commit: ${DIM}$COMMIT${RESET}"
echo -e "  Uncommitted: ${YELLOW}$CHANGES files${RESET}"
if [[ "$AHEAD" -gt 0 ]]; then
    echo -e "  Ahead of remote: ${YELLOW}$AHEAD commits${RESET}"
fi

# ── 2. Efficiency / benchmark history ──────────────────────────────────────────

EFF_FILE="src/analysis/.efficiency-state.json"
CAP_FILE="src/analysis/.capability-state.json"

echo ""
echo -e "${BOLD}── BENCHMARK EFFICIENCY ──────────────────────────────────────────────${RESET}"

if [[ -f "$EFF_FILE" ]]; then
    python3 << 'PYEOF'
import json, sys
try:
    with open("src/analysis/.efficiency-state.json") as f:
        data = json.load(f)
except Exception as e:
    print(f"  Error reading efficiency state: {e}")
    sys.exit(0)

prev = data.get("previous")
history = data.get("history", [])
print(f"  Runs tracked: {len(history)}")
print(f"  Last updated: {data.get('updatedAt', '?')[:19]}")

# Token formatter (matches benchmark.ts / efficiency-tracker.ts)
def fmt_tokens(t):
    if t >= 100000: return f"{t/1000:.0f}k"
    if t >= 10000: return f"{t/1000:.1f}k"
    if t >= 1000: return f"{t/1000:.1f}k"
    return str(int(t))

def fmt_cost(c):
    if c <= 0: return "$0.00"
    if c < 0.01: return "<$0.01"
    return f"${c:.2f}"

if prev:
    passed_count = int(prev["passRate"] * prev["totalProblems"])
    avg_tokens = prev.get("avgPipelineTokens", 0)
    total_tokens = prev.get("totalPipelineTokens", 0)
    avg_cost = prev.get("avgPipelineCost", 0)
    total_cost = prev.get("totalPipelineCost", 0)
    print("")
    print("  LATEST RUN:")
    print(f'    Problems:    {prev["totalProblems"]}')
    print(f'    Pass rate:   {prev["passRate"]*100:.0f}%  ({passed_count}/{prev["totalProblems"]})')
    print(f'    Avg calls:   {prev["avgPipelineCalls"]:.1f} per problem')
    print(f'    Total calls: {prev["totalPipelineCalls"]}')
    if total_tokens > 0:
        print(f'    Total tokens: {fmt_tokens(total_tokens)}')
        print(f'    Avg tokens:   {fmt_tokens(avg_tokens)} per problem')
    if total_cost > 0:
        print(f'    Total cost:   {fmt_cost(total_cost)}')
        print(f'    Avg cost:     {fmt_cost(avg_cost)} per problem')
    print(f'    Commit:      {prev.get("commit", "?")}')
    print(f'    Timestamp:   {prev["timestamp"][:19]}')

    # Show trend if we have at least 2 runs
    if len(history) >= 2:
        print("")
        print("  EFFICIENCY TREND (last 5 runs):")
        for h in history[-5:]:
            pass_pct = h["passRate"] * 100
            calls = h["avgPipelineCalls"]
            tokens = h.get("avgPipelineTokens", 0)
            cost = h.get("avgPipelineCost", 0)
            ts = h["timestamp"][:16].replace("T", " ")
            bar = "\u2588" * max(1, int(pass_pct / 5))
            token_str = f"  {fmt_tokens(tokens)} tk/problem" if tokens > 0 else ""
            cost_str = f"  {fmt_cost(cost)}/problem" if cost > 0 else ""
            print(f"    {ts}  pass={pass_pct:.0f}% {bar}  avg={calls:.1f} calls/problem{token_str}{cost_str}")

        old_calls = history[-2]["avgPipelineCalls"]
        new_calls = history[-1]["avgPipelineCalls"]
        delta_calls = new_calls - old_calls
        old_tokens = history[-2].get("avgPipelineTokens", 0)
        new_tokens = history[-1].get("avgPipelineTokens", 0)
        delta_tokens = new_tokens - old_tokens
        old_cost = history[-2].get("avgPipelineCost", 0)
        new_cost = history[-1].get("avgPipelineCost", 0)
        delta_cost = new_cost - old_cost

        # Primary: cost trend; secondary: token trend; fallback: call trend
        if new_cost > 0 and old_cost > 0:
            if delta_cost < -0.005:
                print(f"    \u2192 Getting MORE efficient (avg cost \u2193 {fmt_cost(abs(delta_cost))})")
            elif delta_cost > 0.005:
                print(f"    \u2192 Getting LESS efficient (avg cost \u2191 {fmt_cost(delta_cost)}) \u2014 INVESTIGATE")
            else:
                print(f"    \u2192 Cost efficiency stable")
        elif new_tokens > 0 and old_tokens > 0:
            if delta_tokens < -100:
                print(f"    \u2192 Getting MORE efficient (avg tokens \u2193 {fmt_tokens(abs(delta_tokens))})")
            elif delta_tokens > 100:
                print(f"    \u2192 Getting LESS efficient (avg tokens \u2191 {fmt_tokens(delta_tokens)}) \u2014 INVESTIGATE")
            else:
                print(f"    \u2192 Token efficiency stable")
        elif delta_calls < -0.5:
            print(f"    \u2192 Getting MORE efficient (avg calls \u2193 {abs(delta_calls):.1f})")
        elif delta_calls > 0.5:
            print(f"    \u2192 Getting LESS efficient (avg calls \u2191 {delta_calls:.1f}) \u2014 INVESTIGATE")
        else:
            print(f"    \u2192 Efficiency stable")
else:
    print("  No previous run yet \u2014 first benchmark needed.")
PYEOF
else
    echo -e "  ${DIM}No .efficiency-state.json — run a benchmark first${RESET}"
    echo "    bun run src/test/benchmark.ts"
fi

# ── 3. Capability state ────────────────────────────────────────────────────────

echo ""
echo -e "${BOLD}── CAPABILITY TRACKER ─────────────────────────────────────────────────${RESET}"

if [[ -f "$CAP_FILE" ]]; then
    python3 << 'PYEOF'
import json
try:
    with open("src/analysis/.capability-state.json") as f:
        data = json.load(f)
except Exception:
    print("  Error reading capability state")
    exit(0)

records = data.get("records", [])
if not records:
    print("  No domain capability data yet")
else:
    # Aggregate records by domain
    by_domain = {}
    for r in records:
        domain = r.get("domain", "unknown")
        if domain not in by_domain:
            by_domain[domain] = {"passed": 0, "total": 0, "tiers": set()}
        by_domain[domain]["total"] += 1
        if r.get("solved"):
            by_domain[domain]["passed"] += 1
        by_domain[domain]["tiers"].add(r.get("modelTier", "?"))

    if not by_domain:
        print("  No domain capability data yet")
    else:
        for domain, info in sorted(by_domain.items()):
            passed = info["passed"]
            total = info["total"]
            pct = passed / total * 100 if total > 0 else 0
            icon = "+" if pct >= 80 else "~" if pct >= 50 else "-"
            tiers = ",".join(str(t) for t in sorted(info["tiers"]))
            print(f"  {icon} {domain}: {passed}/{total} ({pct:.0f}%)  tier={tiers}")
PYEOF
else
    echo -e "  ${DIM}No .capability-state.json — run a benchmark first${RESET}"
fi

# ── 3.5 Priority targets (failing problems by complexity) ────────────────────────

echo ""
echo -e "${BOLD}── PRIORITY TARGETS ──────────────────────────────────────────────────${RESET}"

# Read from efficiency state to get per-problem pass/fail + complexity
if [[ -f "$EFF_FILE" ]]; then
    python3 << 'PYEOF'
import json, os

# ── Load efficiency state (per-benchmark runs) ──
try:
    with open("src/analysis/.efficiency-state.json") as f:
        eff = json.load(f)
except Exception:
    eff = {}

# ── Load capability state (all-time per-problem records) ──
cap_records = []
try:
    with open("src/analysis/.capability-state.json") as f:
        cap = json.load(f)
        cap_records = cap.get("records", [])
except Exception:
    pass

prev = eff.get("previous")
eff_problems = prev.get("problems", []) if prev else []
eff_total = len(eff_problems)

tier_order = {"trivial": 0, "simple": 1, "medium": 2, "hard": 3, "very-hard": 4}

# Group efficiency problems by complexity
by_tier = {}
for p in eff_problems:
    tier = p.get("complexity", "unknown")
    if tier not in by_tier:
        by_tier[tier] = {"total": 0, "passed": 0, "failed": []}
    by_tier[tier]["total"] += 1
    if p.get("passed"):
        by_tier[tier]["passed"] += 1
    else:
        by_tier[tier]["failed"].append(p["name"])

# Show efficiency-based progression if we have data
if by_tier:
    print("  Progression ladder (from latest benchmark):")
    for tier in ["trivial", "simple", "medium", "hard", "very-hard"]:
        if tier not in by_tier:
            continue
        info = by_tier[tier]
        pct = info["passed"] / info["total"] * 100
        icon = "+" if pct == 100 else "~" if pct >= 50 else "-"
        print(f"    {icon} {tier}: {info['passed']}/{info['total']} ({pct:.0f}%)")

    # Find first failing tier
    target_tier = None
    for tier in ["trivial", "simple", "medium", "hard", "very-hard"]:
        if tier in by_tier and by_tier[tier]["failed"]:
            target_tier = tier
            break

    all_failing = []
    for tier in ["trivial", "simple", "medium", "hard", "very-hard"]:
        if tier in by_tier:
            all_failing.extend(by_tier[tier]["failed"])

    if target_tier:
        failing = by_tier[target_tier]["failed"]
        print(f"\n  Next target: {target_tier}")
        print(f"    Failing: {', '.join(failing)}")
        if target_tier == "trivial":
            print(f"    Action: Fix oracles — these should be trivially solvable")
        elif target_tier == "simple":
            print(f"    Action: Check if oracle is too strict or prompt is confusing model")
        elif target_tier in ("medium", "hard"):
            print(f"    Action: Run individual failing problems, read logs, identify failure mode")
        else:
            print(f"    Action: This tier is at the frontier — needs new capabilities")

    print("\n  Run commands:")
    if all_failing:
        filter_str = "|".join(all_failing)
        print(f"    bun run src/test/benchmark.ts --failing")
        print(f"    PROBLEM_FILTER=\"{filter_str}\" bun run src/test/benchmark.ts")
    if target_tier:
        print(f"    bun run src/test/benchmark.ts --tier={target_tier}")
    elif eff_total < 10:
        print(f"    bun run src/test/benchmark.ts --all   # Only {eff_total} problems in last run — run full benchmark")

# ── Supplement with capability-state data for low-pass-rate domains ──
if cap_records:
    # Aggregate by domain
    by_domain = {}
    for r in cap_records:
        domain = r.get("domain", "unknown")
        if domain not in by_domain:
            by_domain[domain] = {"passed": 0, "total": 0}
        by_domain[domain]["total"] += 1
        if r.get("solved"):
            by_domain[domain]["passed"] += 1

    # Find struggling domains (<50% pass rate, at least 3 attempts)
    struggling = []
    for domain, info in by_domain.items():
        if info["total"] >= 3:
            pct = info["passed"] / info["total"] * 100
            if pct < 50:
                struggling.append((domain, pct, info["passed"], info["total"]))

    if struggling:
        struggling.sort(key=lambda x: x[1])  # worst first
        if eff_total < 10:
            print(f"\n  Low-pass domains (all-time, from capability tracker):")
        else:
            print(f"\n  Additional low-pass domains (all-time):")
        for domain, pct, passed, total in struggling[:5]:
            print(f"    - {domain}: {passed}/{total} ({pct:.0f}%)")

# If neither source has data
if not by_tier and not cap_records:
    print("  No benchmark data yet — run a benchmark:")
    print("    bun run src/test/benchmark.ts")
elif not by_tier and cap_records:
    print("\n  Run a full benchmark to populate efficiency data:")
    print("    bun run src/test/benchmark.ts --all")
PYEOF
else
    echo -e "  ${DIM}No .efficiency-state.json — run a benchmark first${RESET}"
    echo "    bun run src/test/benchmark.ts"
fi

# ── 4. Recent runs (from logs) ─────────────────────────────────────────────────

LOG_DIR="logs"
echo ""
echo -e "${BOLD}── RECENT RUNS (last 10) ─────────────────────────────────────────────${RESET}"

if [[ -d "$LOG_DIR" ]]; then
    shopt -s nullglob
    LOGFILES=($(ls -t "$LOG_DIR"/truth-engine-*.log 2>/dev/null | grep -v '\.full\.log$' | head -10))
    shopt -u nullglob

    if [[ ${#LOGFILES[@]} -gt 0 ]]; then
        printf "  %-3s %-16s %6s %8s %6s %6s %7s\n" "" "WHEN" "CALLS" "TOKENS" "RESULT" "TIME" "COST"
        for i in "${!LOGFILES[@]}"; do
            f="${LOGFILES[$i]}"
            # LLM call count
            calls=$(safe_grep_count "RAW RESPONSE" "$f")
            # Token sum: matches "tokens: 793p + 67c = 860" and sums the total
            tokens=$(safe_grep "tokens:" "$f" | grep -oP '=\s*\K\d+' | paste -sd+ 2>/dev/null | bc 2>/dev/null || echo "0")
            # Cost sum: matches "cost: $0.001234"
            cost=$(safe_grep "cost:" "$f" | grep -oP '\$\K[\d.]+' | paste -sd+ 2>/dev/null | bc 2>/dev/null || echo "0")
            cost_fmt=""
            if [[ "$cost" != "0" && -n "$cost" ]]; then
                cost_fmt=$(printf "$%.2f" "$cost")
            fi
            # Result detection: check for EVENT markers first, then fall back to oracle results
            result="???"
            if safe_grep -q "EVENT.*SOLVED\|PROBLEM SOLVED\|PASS:" "$f"; then result="PASS"
            elif safe_grep -q "EVENT.*FAILED\|killed\|ABORT\b" "$f"; then result="FAIL"
            elif [[ "$(safe_grep_count "oracle.*PASS\|oracle.*Passed\|all tests passed" "$f")" -gt 0 ]]; then result="PASS"
            elif [[ "$(safe_grep_count "oracle.*FAIL\|oracle.*Failed" "$f")" -gt 0 ]]; then result="FAIL"
            fi
            # Duration
            started=$(head -5 "$f" | safe_grep "Started:" | head -1 | sed 's/.*Started: //' | head -c 19)
            dur="?"
            if [[ -n "$started" ]]; then
                s_epoch=$(date -d "$started" +%s 2>/dev/null || echo 0)
                mtime=$(stat -c %Y "$f" 2>/dev/null || echo 0)
                if [[ "$s_epoch" -gt 0 && "$mtime" -gt "$s_epoch" ]]; then
                    dur="$(( (mtime - s_epoch) ))s"
                fi
            fi
            # Timestamp from Started line
            ts=$(head -3 "$f" | safe_grep "Started:" | head -1 | sed 's/.*Started: //' | head -c 16 | sed 's/T/ /')
            printf "  %-3s %-16s %6s %8s %6s %6s %7s\n" "$i" "${ts:-?}" "$calls" "$tokens" "$result" "$dur" "${cost_fmt:-}"
        done
    else
        echo -e "  ${DIM}No log files in logs/${RESET}"
    fi
else
    echo -e "  ${DIM}No logs/ directory${RESET}"
fi

# ── 5. Current failures (last run that failed) ─────────────────────────────────

echo ""
echo -e "${BOLD}── CURRENT FAILURES ──────────────────────────────────────────────────${RESET}"

if [[ -d "$LOG_DIR" ]]; then
    LAST_FAIL=""
    for f in $(ls -t "$LOG_DIR"/truth-engine-*.log 2>/dev/null | grep -v '\.full\.log$'); do
        if safe_grep -q "EVENT.*FAILED\|killed\|ABORT\b" "$f"; then
            LAST_FAIL="$f"
            break
        fi
    done

    if [[ -n "$LAST_FAIL" ]]; then
        echo "  File: $(basename "$LAST_FAIL")"
        echo ""
        # Show key errors — strip prompt/PARSED JSON sections first (same as logs.sh -e)
        echo "  Key errors:"
        awk '
            /^── SYSTEM PROMPT/     { in_skip=1; next }
            /^── USER PROMPT/       { in_skip=1; next }
            /^── PARSED JSON/       { in_json=1; next }
            /^── STATUS: OK/        { in_json=0 }
            /^── RAW RESPONSE/      { in_skip=0; in_json=0 }
            !in_skip && !in_json
        ' "$LAST_FAIL" 2>/dev/null | safe_grep -i "── ERROR\|error\|exception\|failed\|killed\|abort\|stuck\|Traceback" | \
            safe_grep -v "fail.*mode\|possible_failure\|const.*errors\b" | \
            tail -5 | while IFS= read -r line; do echo "    $line"; done
    else
        echo -e "  ${GREEN}No recent failures found${RESET}"
    fi
fi

# ── 6. Sandbox health ──────────────────────────────────────────────────────────

echo ""
echo -e "${BOLD}── SANDBOX ───────────────────────────────────────────────────────────${RESET}"
echo "  Node:   $(node --version 2>/dev/null || echo 'NOT FOUND')"
echo "  Bun:    $(bun --version 2>/dev/null || echo 'NOT FOUND')"
echo "  Python: $(python3 --version 2>/dev/null || echo 'NOT FOUND')"
echo "  SQLite: $(sqlite3 --version 2>/dev/null || echo 'NOT FOUND')"
if [[ -d workspaces ]]; then
    echo "  Workspaces: $(ls workspaces/ 2>/dev/null | wc -l) active"
fi

# ── 7. Token usage summary (aggregate from latest log) ─────────────────────────

echo ""
echo -e "${BOLD}── TOKEN USAGE & COST (latest log) ────────────────────────────────────${RESET}"

LATEST_LOG=$(ls -t "$LOG_DIR"/truth-engine-*.log 2>/dev/null | grep -v '\.full\.log$' | head -1 || true)
if [[ -n "$LATEST_LOG" ]]; then
    CALL_COUNT=$(safe_grep_count "RAW RESPONSE" "$LATEST_LOG")
    # Sum prompt and completion tokens from "tokens: Xp + Yc = Z" format
    TOKEN_DATA=$(safe_grep "tokens:" "$LATEST_LOG")
    TOTAL_TOKENS=0
    TOTAL_PROMPT=0
    TOTAL_COMPLETION=0
    if [[ -n "$TOKEN_DATA" ]]; then
        TOTAL_TOKENS=$(echo "$TOKEN_DATA" | grep -oP '=\s*\K\d+' | paste -sd+ | bc 2>/dev/null || echo "0")
        TOTAL_PROMPT=$(echo "$TOKEN_DATA" | grep -oP '\d+(?=p)' | paste -sd+ | bc 2>/dev/null || echo "0")
        TOTAL_COMPLETION=$(echo "$TOKEN_DATA" | grep -oP '\d+(?=c)' | paste -sd+ | bc 2>/dev/null || echo "0")
        AVG_PER_CALL=$(( TOTAL_TOKENS / CALL_COUNT ))
        echo "  Calls: $CALL_COUNT"
        echo "  Total tokens: $TOTAL_TOKENS  (${TOTAL_PROMPT}p + ${TOTAL_COMPLETION}c)"
        echo "  Avg per call: $AVG_PER_CALL tokens"
        # Cost: sum all "cost: $X.XXXXXX" lines
        COST_DATA=$(safe_grep "cost:" "$LATEST_LOG")
        if [[ -n "$COST_DATA" ]]; then
            TOTAL_COST=$(echo "$COST_DATA" | grep -oP '\$\K[\d.]+' | paste -sd+ | bc 2>/dev/null || echo "0")
            if [[ "$TOTAL_COST" != "0" && -n "$TOTAL_COST" ]]; then
                AVG_COST=$(echo "scale=6; $TOTAL_COST / $CALL_COUNT" | bc 2>/dev/null || echo "0")
                printf -v COST_FMT "%.4f" "$TOTAL_COST"
                printf -v AVG_COST_FMT "%.6f" "$AVG_COST"
                echo "  Total cost: \$${COST_FMT}  (avg \$${AVG_COST_FMT} per call)"
            fi
        fi
    else
        echo "  ${DIM}No per-call token data in this log (usage may not be reported by API)${RESET}"
    fi
else
    echo -e "  ${DIM}No log files${RESET}"
fi

# ── 8. Quick commands ──────────────────────────────────────────────────────────

echo ""
echo -e "${BOLD}── QUICK COMMANDS ────────────────────────────────────────────────────${RESET}"
echo "  ./scripts/status.sh      This dashboard"
echo "  ./scripts/logs.sh -l     List all runs with call/token counts"
echo "  ./scripts/logs.sh        Latest run summary"
echo "  ./scripts/logs.sh -e     Latest run errors"
echo "  ./scripts/logs.sh -t     Token usage per call"
echo "  ./scripts/logs.sh -a     Agent actions (turn-by-turn)"
echo "  ./scripts/debug.sh       Deep debug: per-turn breakdown, failure classification"
echo "  ./scripts/dev.sh \"prob\" Quick single-problem test"
echo "  bun run src/test/benchmark.ts --all      Full benchmark (all 41)"
echo "  bun run src/test/benchmark.ts --failing  Only problems that failed last run"
echo "  bun run src/test/benchmark.ts --tier=hard  All problems in a tier"
	echo "  bun run src/test/benchmark.ts --cross-prompt  Per-problem across prompt versions"
	echo "  bun run src/test/benchmark.ts --consistency-report  Stability per problem"
	echo "  bun run src/test/benchmark.ts --prompt-report  Prompt version history"
echo "  PROBLEM_FILTER=\"name\" bun run src/test/benchmark.ts"
echo ""
echo -e "${DIM}${BAR}${RESET}"
