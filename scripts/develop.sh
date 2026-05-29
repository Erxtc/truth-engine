#!/usr/bin/env bash
# Launch a claude agent to work on the truth-engine project.
# Usage:
#   bun develop                 interactive session with project context
#   bun develop NAME            run named prompt from prompts.json
#   bun develop N               run prompt by index (1-based) from prompts.json
#   bun develop "free text"     run with that specific prompt
#   bun develop --list          list all named prompts
#   bun develop --watch         tail the latest background run
#
# Flags:
#   --bg                        run in background, log to file
#   --no-pull                   skip git pull before starting
#   --watch, -w                 tail -f the latest background run

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"
cd "$ROOT"

PROMPTS_FILE="$ROOT/prompts.json"
LOGDIR="$ROOT/logs/develop"
SYNC=true
BACKGROUND=false
INPUT=""

# ── Parse flags ─────────────────────────────────────────────────────────────

while [[ $# -gt 0 ]]; do
    case "$1" in
        --bg|--background)
            BACKGROUND=true
            shift
            ;;
        --no-pull|--no-sync)
            SYNC=false
            shift
            ;;
        --watch|-w)
            LATEST=$(ls -t "$LOGDIR"/*.log 2>/dev/null | head -1)
            if [[ -z "$LATEST" ]]; then
                echo "No background runs yet."
                exit 1
            fi
            echo "→ Tailing: $LATEST"
            # Show recent context first
            DONEFILE="${LATEST%.log}.done"
            if [[ -f "$DONEFILE" ]]; then
                echo "→ Status:  $(cat "$DONEFILE")"
                echo ""
            else
                echo "→ Status:  still running"
                echo "→ Lines:   $(wc -l < "$LATEST") so far"
                echo ""
                echo "── last 15 lines ──"
                tail -15 "$LATEST"
                echo "── watching ──"
            fi
            exec tail -f "$LATEST"
            ;;
        --status|-s)
            echo "── Background runs ──"
            echo ""
            RUNNING=0
            DONE=0
            for log in $(ls -t "$LOGDIR"/*.log 2>/dev/null); do
                name="$(basename "$log")"
                donename="${name%.log}.done"
                donefile="$LOGDIR/$donename"
                lines=$(wc -l < "$log")
                if [[ -f "$donefile" ]]; then
                    status="$(cat "$donefile")"
                    if grep -q "^EXIT:0" "$donefile" 2>/dev/null; then
                        echo "  ✓ $name  ($status, $lines lines)"
                    else
                        echo "  ✗ $name  ($status, $lines lines)"
                    fi
                    DONE=$((DONE + 1))
                else
                    # Still running — check if PID is alive
                    ts="${name%%-*}"
                    age=""
                    echo "  ● $name  ($lines lines — running)"
                    RUNNING=$((RUNNING + 1))
                fi
            done
            if [[ ! "$(ls "$LOGDIR"/*.log 2>/dev/null)" ]]; then
                echo "  (no background runs yet)"
            fi
            echo ""
            echo "  $RUNNING running, $DONE done"
            echo ""
            echo "  Watch:  bun develop --watch"
            echo "  Clean:  rm $LOGDIR/*.log $LOGDIR/*.done"
            exit 0
            ;;
        --list|-l)
            echo "── prompts.json ──"
            bun -e "
import { readFileSync } from 'fs'
const prompts = JSON.parse(readFileSync('$PROMPTS_FILE','utf-8'))
const keys = Object.keys(prompts)
const maxLen = Math.max(...keys.map(k => k.length))
keys.forEach((k, i) => {
    const label = (k + ':').padEnd(maxLen + 3)
    console.log('  [' + (i+1) + '] ' + label + prompts[k])
    console.log('')
})
"
            exit 0
            ;;
        --help|-h)
            echo "Usage: bun develop [--bg] [--no-pull] [NAME|N|\"prompt\"|--list|--watch|--status]"
            echo ""
            echo "  bun develop              Interactive claude session"
            echo "  bun develop clean        Run the 'clean' prompt"
            echo "  bun develop fix          Run the 'fix' prompt"
            echo "  bun develop N            Run prompt at index N (1-based)"
            echo "  bun develop \"task\"       Run with custom prompt"
            echo "  bun develop --list       List all named prompts"
            echo "  bun develop --status     Show all background runs + their state"
            echo "  bun develop --watch      Tail the latest background run"
            echo ""
            echo "Flags:"
            echo "  --bg                     Run in background, log to logs/develop/"
            echo "  --no-pull                Skip git pull before starting"
            exit 0
            ;;
        --*)
            echo "Unknown flag: $1"
            exit 1
            ;;
        *)
            INPUT="$1"
            shift
            break
            ;;
    esac
done

# ── Sync before starting ────────────────────────────────────────────────────

if $SYNC && [[ -n "$INPUT" || $BACKGROUND == false ]]; then
    echo "→ Syncing latest changes..."
    git pull --ff-only 2>/dev/null || echo "   (unable to pull — continuing with local state)"
fi

# ── Slug helper ─────────────────────────────────────────────────────────────

slugify() {
    echo "$1" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+|-+$//g' | head -c 40
}

# ── Mini status (shown at startup and after bg launch) ──────────────────────

mini_status() {
    local logs=($(ls -t "$LOGDIR"/*.log 2>/dev/null))
    if [[ ${#logs[@]} -eq 0 ]]; then
        return
    fi
    local running=0 done=0
    echo ""
    echo "  ── fleet ──"
    for log in "${logs[@]}"; do
        local name donename donefile lines
        name="$(basename "$log")"
        donename="${name%.log}.done"
        donefile="$LOGDIR/$donename"
        lines=$(wc -l < "$log" 2>/dev/null || echo 0)
        if [[ -f "$donefile" ]]; then
            local status
            status="$(cat "$donefile")"
            if grep -q "^EXIT:0" "$donefile" 2>/dev/null; then
                echo "  ✓ $name  ($status)"
            else
                echo "  ✗ $name  ($status)"
            fi
            done=$((done + 1))
        else
            echo "  ● $name  (${lines} lines, running)"
            running=$((running + 1))
        fi
    done
    echo ""
}

# ── Mission ─────────────────────────────────────────────────────────────────

MISSION="Read CLAUDE.md. We're working with our best thoughts, knowledge and ideas aiming at building the best possible truth engine we can make with realistic practical improvements.

⚠️  This codebase is actively being worked on by other agents simultaneously. Before you make changes: git pull to get the latest. Work on a branch (git checkout -b <descriptive-slug>). Commit your changes with good messages. Push when done. Don't leave uncommitted work in the working tree — others may depend on a clean state."

# ── System prompt ───────────────────────────────────────────────────────────

SYSTEM_PROMPT="You are working in the truth-engine project at $ROOT.

$(cat "$ROOT/CLAUDE.md")"

# ── Interactive mode (no input) ─────────────────────────────────────────────

if [[ -z "$INPUT" ]]; then
    echo ""
    echo "╔══════════════════════════════════════════════════════════════╗"
    echo "║  truth-engine · developer session                           ║"
    echo "╠══════════════════════════════════════════════════════════════╣"
    echo "║  Available prompts (bun develop <name>):                     ║"
    bun -e "
import { readFileSync } from 'fs'
const prompts = JSON.parse(readFileSync('$PROMPTS_FILE','utf-8'))
const keys = Object.keys(prompts)
keys.forEach(k => {
    const desc = prompts[k].length > 48 ? prompts[k].substring(0, 48) + '...' : prompts[k]
    const label = '  ' + (k + ':').padEnd(15)
    console.log('║' + label + desc.padEnd(50) + '║')
})
"
    echo "╠══════════════════════════════════════════════════════════════╣"
    echo "║  Commands:  bun develop --status  (see all bg runs)        ║"
    echo "║             bun develop --watch   (tail latest)            ║"
    echo "║             bun develop --bg NAME (fire and forget)        ║"
    echo "║             bun develop --list    (all prompts)            ║"
    echo "╚══════════════════════════════════════════════════════════════╝"

    # Show fleet status if anything is running
    if ls "$LOGDIR"/*.log &>/dev/null; then
        mini_status
    fi

    echo "  ⚡ Launching claude with full project context + CLAUDE.md..."
    echo "     (type /name for quick prompts, Ctrl-C to exit)"
    echo ""
    exec claude \
        --dangerously-skip-permissions \
        --system-prompt "$SYSTEM_PROMPT" \
        "$MISSION"
fi

# ── Resolve prompt ──────────────────────────────────────────────────────────

PROMPT=$(bun -e "
import { readFileSync } from 'fs'
const prompts = JSON.parse(readFileSync('$PROMPTS_FILE','utf-8'))
const input = \`$INPUT\`

// Try named key first
if (input in prompts) {
    console.log(prompts[input])
    process.exit(0)
}

// Try numeric index (1-based)
const n = parseInt(input, 10)
if (!isNaN(n) && n >= 1 && n <= Object.keys(prompts).length) {
    const key = Object.keys(prompts)[n - 1]
    console.log('[' + key + '] ' + prompts[key])
    process.exit(0)
}

// Raw prompt
console.log(input)
")

FULL_PROMPT="$MISSION

Task: $PROMPT"

# ── Show what's happening ───────────────────────────────────────────────────

SLUG=$(slugify "${INPUT:-task}")
LOGNAME="$(date +%Y%m%d-%H%M%S)-${SLUG}.log"
mkdir -p "$LOGDIR"

if $BACKGROUND; then
    # ── Background mode ─────────────────────────────────────────────────────
    echo "→ Background run: $LOGDIR/$LOGNAME"
    echo "→ Task: $PROMPT"
    echo ""

    (
        START=$(date +%s)
        set +e
        claude \
            --print \
            --dangerously-skip-permissions \
            --system-prompt "$SYSTEM_PROMPT" \
            --no-session-persistence \
            "$FULL_PROMPT" \
            > "$LOGDIR/$LOGNAME" 2>&1
        RC=$?
        END=$(date +%s)
        ELAPSED=$((END - START))
        echo "EXIT:$RC ELAPSED:${ELAPSED}s $(date '+%H:%M:%S')" > "$LOGDIR/${LOGNAME%.log}.done"
        # Signal completion visibly in the log
        if [[ "$RC" -eq 0 ]]; then
            echo "" >> "$LOGDIR/$LOGNAME"
            echo "═══ DONE (${ELAPSED}s) ═══" >> "$LOGDIR/$LOGNAME"
        else
            echo "" >> "$LOGDIR/$LOGNAME"
            echo "═══ FAILED exit=$RC (${ELAPSED}s) ═══" >> "$LOGDIR/$LOGNAME"
        fi
    ) &>/dev/null &

    PID=$!
    echo "   PID: $PID"
    echo ""

    sleep 2
    if kill -0 "$PID" 2>/dev/null; then
        echo "   ✓ Agent running. Use 'bun develop --watch' to follow."
        echo "   Result file:  $LOGDIR/${LOGNAME%.log}.done"
        mini_status
    else
        echo "   ✗ Agent exited immediately — check the log:"
        echo ""
        tail -20 "$LOGDIR/$LOGNAME"
    fi
else
    # ── Foreground mode ─────────────────────────────────────────────────────
    echo "→ Task: $PROMPT"
    echo ""

    START=$(date +%s)
    set +e +o pipefail
    claude \
        --print \
        --output-format stream-json \
        --include-partial-messages \
        --verbose \
        --dangerously-skip-permissions \
        --system-prompt "$SYSTEM_PROMPT" \
        --no-session-persistence \
        "$FULL_PROMPT" \
        2>&1 | bun run "$ROOT/scripts/stream-filter.ts"
    RC=${PIPESTATUS[0]}
    END=$(date +%s)
    ELAPSED=$((END - START))

    echo ""
    if [[ "$RC" -eq 0 ]]; then
        echo "╔══════════════════════════════════════════════════════════════╗"
        echo "║  ✓  DONE  (${ELAPSED}s)                                          ║"
        echo "╚══════════════════════════════════════════════════════════════╝"
    else
        echo "╔══════════════════════════════════════════════════════════════╗"
        echo "║  ✗  FAILED (exit=$RC, ${ELAPSED}s)                                 ║"
        echo "╚══════════════════════════════════════════════════════════════╝"
    fi
    mini_status
    exit "$RC"
fi
