#!/usr/bin/env bash
# Prompt history — shows prompt version history, cross-version performance,
# and per-problem pass/fail across versions.
#
# Usage:
#   ./scripts/prompt-history.sh              # summary view
#   ./scripts/prompt-history.sh --full       # detailed view with per-problem breakdown
#   ./scripts/prompt-history.sh --problem=X  # focus on one problem across versions
#
# This helps answer: "Did the prompt change help or hurt?"

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

PV_FILE="src/analysis/.prompt-versions.json"
MODE="${1:---summary}"
FOCUS=""
if [[ "$MODE" == --problem=* ]]; then
    FOCUS="${MODE#--problem=}"
    MODE="--problem"
fi
if [[ "$1" == "--full" ]]; then
    MODE="--full"
fi

if [[ ! -f "$PV_FILE" ]]; then
    echo -e "${YELLOW}No .prompt-versions.json found. Run a benchmark first.${RESET}"
    exit 1
fi

python3 << PYEOF
import json, sys

try:
    with open("src/analysis/.prompt-versions.json") as f:
        data = json.load(f)
except Exception as e:
    print(f"Error reading prompt versions: {e}")
    sys.exit(1)

current = data.get("currentHash", "")
summaries = data.get("summaries", {})
runs = data.get("runs", {})
mode = "$MODE"
focus = "$FOCUS"

if not summaries:
    print("No prompt versions recorded yet.")
    sys.exit(0)

versions = sorted(summaries.values(), key=lambda v: v.get("lastSeen", ""), reverse=True)

print()
print("═" * 70)
print("  PROMPT VERSION HISTORY")
print("═" * 70)

# ── Overall summary ──
print(f"\n  Current:  {current if current else '(not set)'}")
print(f"  Versions: {len(versions)}")
print(f"  Total runs tracked: {sum(v['totalUses'] for v in versions)}")

# ── Version timeline ──
print(f"\n{'─' * 70}")
print("  VERSION TIMELINE (newest → oldest)")
print(f"{'─' * 70}")

for v in versions:
    marker = " ← CURRENT" if v["hash"] == current else ""
    rate = v["passRate"] * 100
    icon = "+" if rate >= 80 else "~" if rate >= 50 else "-"
    print(f"\n  {icon} {v['hash']}{marker}")
    print(f"     Pass rate:    {rate:.0f}% ({int(rate * v['totalUses'] / 100)}/{v['totalUses']})")
    print(f"     Used:         {v['totalUses']}x across {v['uniqueProblems']} problems")
    print(f"     First seen:   {v['firstSeen'][:19]}")
    print(f"     Last used:    {v['lastSeen'][:19]}")

# ── Cross-version comparison ──
if len(versions) >= 2:
    print(f"\n{'─' * 70}")
    print("  CROSS-VERSION COMPARISON")
    print(f"{'─' * 70}")

    # Current vs previous
    cur = versions[0] if current and current == versions[0]["hash"] else (summaries.get(current) if current else None)
    prev = versions[1] if cur and versions[0] == cur else versions[0]

    if cur and prev:
        print(f"\n  Current  ({cur['hash']}): {cur['passRate']*100:.0f}% pass rate, {cur['totalUses']} uses")
        print(f"  Previous ({prev['hash']}): {prev['passRate']*100:.0f}% pass rate, {prev['totalUses']} uses")
        delta = (cur["passRate"] - prev["passRate"]) * 100
        if delta > 0:
            print(f"  → {GREEN}IMPROVEMENT: +{delta:.0f}%{RESET}")
        elif delta < 0:
            print(f"  → {RED}REGRESSION: {delta:.0f}%{RESET}")
        else:
            print(f"  → No change")

        # Common problems
        cur_probs = set(cur.get("problemResults", {}).keys())
        prev_probs = set(prev.get("problemResults", {}).keys())
        common = sorted(cur_probs & prev_probs)

        if common:
            newly_passing = []
            newly_failing = []
            for prob in common:
                cp = cur["problemResults"][prob]
                pp = prev["problemResults"][prob]
                if cp.get("lastPassed") and not pp.get("lastPassed"):
                    newly_passing.append(prob)
                if not cp.get("lastPassed") and pp.get("lastPassed"):
                    newly_failing.append(prob)

            if newly_passing:
                print(f"\n    {GREEN}✓ Newly passing ({len(newly_passing)}):{RESET}")
                for p in newly_passing:
                    print(f"      {p}")
            if newly_failing:
                print(f"\n    {RED}✗ Newly failing ({len(newly_failing)}):{RESET}")
                for p in newly_failing:
                    print(f"      {p}")
            if not newly_passing and not newly_failing:
                print(f"\n    → Same pass/fail for all {len(common)} common problems")

# ── Per-problem across versions ──
if mode == "--problem" and focus:
    print(f"\n{'─' * 70}")
    print(f"  PROBLEM: {focus} — across prompt versions")
    print(f"{'─' * 70}")

    found = False
    for v in versions:
        pr = v.get("problemResults", {}).get(focus)
        if pr:
            found = True
            marker = " ← current" if v["hash"] == current else ""
            icon = "+" if pr["lastPassed"] else "-"
            total = pr["passes"] + pr["failures"]
            avg_calls = pr["totalCalls"] / total if total > 0 else 0
            print(f"  {icon} {v['hash']}{marker}: {pr['passes']}/{total} pass, avg {avg_calls:.1f} calls")
    if not found:
        print(f"  No runs for '{focus}' across any prompt version")

elif mode == "--full":
    print(f"\n{'─' * 70}")
    print("  PER-PROBLEM BREAKDOWN (current version)")
    print(f"{'─' * 70}")

    if current and current in summaries:
        cur = summaries[current]
        probs = sorted(cur.get("problemResults", {}).items(),
                       key=lambda x: x[1]["passes"] + x[1]["failures"],
                       reverse=True)
        for name, pr in probs:
            icon = "+" if pr["lastPassed"] else "-"
            total = pr["passes"] + pr["failures"]
            avg_calls = pr["totalCalls"] / total if total > 0 else 0
            avg_tokens = pr["totalTokens"] / total if total > 0 else 0
            tk = f"{avg_tokens/1000:.1f}k" if avg_tokens >= 1000 else str(int(avg_tokens))
            print(f"  {icon} {name:<28} {pr['passes']}/{total} pass  avg {avg_calls:.1f} calls  {tk} tokens")
    else:
        print("  No current version data")

# ── Cache recommendations ──
print(f"\n{'─' * 70}")
print("  SMART CACHE STATUS")
print(f"{'─' * 70}")

# Count prompts that would benefit from auto-cache
auto_cache_count = 0
for v in versions:
    for prob_name, pr in v.get("problemResults", {}).items():
        total = pr["passes"] + pr["failures"]
        if total > 2:
            auto_cache_count += 1

if auto_cache_count > 0:
    print(f"  {auto_cache_count} problem×version combos have >2 runs — eligible for auto-cache")
    print(f"  To enable smart caching: CACHE_MODE=auto bun run src/test/benchmark.ts ...")
else:
    print(f"  No combos with >2 runs yet. Run more benchmarks to build cache eligibility.")

print()
print("═" * 70)
PYEOF
