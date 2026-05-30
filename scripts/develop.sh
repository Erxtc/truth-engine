#!/usr/bin/env bash
# Launch a claude agent to work on the truth-engine project.
# Usage:
#   bun develop                 interactive session with project context
#   bun develop NAME            run named prompt from prompts.json
#   bun develop N               run prompt by index (1-based) from prompts.json
#   bun develop "free text"     run with that specific prompt
#   bun develop --list          list all named prompts
#   bun develop --watch         tail the latest background run
#   bun develop --resume        resume the last session after a crash
#   bun develop --continue      continue the most recent conversation
#
# Flags:
#   --bg                        run in background, log to file
#   --no-pull                   skip git pull before starting
#   --watch, -w                 tail -f the latest background run
#   --resume, -r                resume last crashed/incomplete session
#   --continue, -c              continue most recent conversation (claude built-in)
#   --clean-sessions            remove completed session files

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"
cd "$ROOT"

# ── Self-heal: restore develop entry if an agent removed it ────────────────
# Runs on EVERY invocation. If the entry is missing from package.json, it's
# restored before anything else happens. This makes deletion harmless.
_self_heal_develop_entry() {
    local pkg="$ROOT/package.json"
    if ! grep -q '"develop"' "$pkg" 2>/dev/null; then
        bun -e "
import { readFileSync, writeFileSync } from 'fs'
const pkg = JSON.parse(readFileSync('$pkg', 'utf-8'))
if (!pkg.scripts) pkg.scripts = {}
// Reconstruct with develop first, preserving all other entries
const scripts = { develop: 'bash scripts/develop.sh' }
for (const [k, v] of Object.entries(pkg.scripts)) {
  if (k !== 'develop') scripts[k] = v
}
pkg.scripts = scripts
writeFileSync('$pkg', JSON.stringify(pkg, null, 2) + '\n')
" 2>/dev/null && echo "→ Self-healed: restored 'develop' entry in package.json" || true
    fi
}
_self_heal_develop_entry

PROMPTS_FILE="$ROOT/prompts.json"
LOGDIR="$ROOT/logs/develop"
SYNC=true
BACKGROUND=false
PRINT_MODE=false
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
        --resume|-r)
            STATE_FILE="$LOGDIR/last-session-state.txt"
            if [[ -f "$STATE_FILE" ]]; then
                SESSION_ID=$(cat "$STATE_FILE" | head -1)
                SESSION_STATE=$(cat "$LOGDIR/last-session-status.txt" 2>/dev/null || echo "unknown")
                echo "→ Resuming session: $SESSION_ID"
                echo "→ Previous status: $SESSION_STATE"
                echo ""
                mkdir -p "$LOGDIR"
                # Interactive resume — stays alive after loading. No --print.
                # Print sessions can't be resumed with --print (no deferred marker),
                # but interactive resume loads the full conversation history.
                exec claude \
                    --dangerously-skip-permissions \
                    --resume "$SESSION_ID" \
                    "Let's pick up where we left off and continue working."
            else
                echo "No session to resume."
                echo ""
                echo "→ Trying claude --continue instead..."
                exec claude --continue --dangerously-skip-permissions "Let's pick up where we left off."
            fi
            ;;
        --continue|-c)
            echo "→ Continuing most recent conversation..."
            exec claude --continue --dangerously-skip-permissions
            ;;
        --clean-sessions)
            echo "→ Cleaning completed session files..."
            CLEANED=0
            for statefile in "$LOGDIR"/last-session-state-*.txt; do
                [[ -f "$statefile" ]] || continue
                if grep -q "^COMPLETED" "$statefile" 2>/dev/null; then
                    rm -f "$statefile"
                    CLEANED=$((CLEANED + 1))
                fi
            done
            if [[ -f "$LOGDIR/last-session-status.txt" ]] && grep -q "^COMPLETED" "$LOGDIR/last-session-status.txt" 2>/dev/null; then
                rm -f "$LOGDIR/last-session-state.txt" "$LOGDIR/last-session-status.txt"
                CLEANED=$((CLEANED + 1))
            fi
            echo "   Cleaned $CLEANED session state files."
            exit 0
            ;;
        --print|-p)
            PRINT_MODE=true
            shift
            ;;
        --help|-h)
            echo "Usage: bun develop [--bg|--print] [NAME|N|\"prompt\"|--list|--watch|--status|--resume|--continue]"
            echo ""
            echo "  bun develop              Interactive claude session"
            echo "  bun develop strategize   Step back, think architecturally"
            echo "  bun develop execute      Dive in, implement, improve"
            echo "  bun develop N            Run prompt at index N (1-based)"
            echo "  bun develop \"task\"       Run with custom prompt (interactive)"
            echo "  bun develop --list       List all named prompts"
            echo "  bun develop --status     Show all background runs + their state"
            echo "  bun develop --watch      Tail the latest background run"
            echo "  bun develop --resume     Resume last crashed session"
            echo "  bun develop --continue   Continue most recent conversation"
            echo ""
            echo "Modes:"
            echo "  (default)                Interactive — task runs, then session stays alive"
            echo "                           Type follow-up prompts to keep iterating"
            echo "  --print, -p              One-shot — streams output, exits when done"
            echo "  --bg                     Background — logs to file, fire and forget"
            echo ""
            echo "Iteration flow:"
            echo "  bun develop strategize   ← step back, think architecturally"
            echo "  (type follow-up in session)"
            echo "  bun develop execute      ← dive in, implement, improve"
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
    echo "║  Iterate:   bun develop strategize  (step back, think)     ║"
    echo "║             bun develop execute     (dive in, build)       ║"
    echo "║             ...or stay in session and type follow-ups       ║"
    echo "╠══════════════════════════════════════════════════════════════╣"
    echo "║  Modes:     bun develop --print X   (one-shot streaming)   ║"
    echo "║             bun develop --bg NAME   (fire and forget)      ║"
    echo "║             bun develop --resume    (recover from crash)   ║"
    echo "║             bun develop --status    (see all bg runs)      ║"
    echo "║             bun develop --watch     (tail latest)          ║"
    echo "║             bun develop --list      (all prompts)          ║"
    echo "╚══════════════════════════════════════════════════════════════╝"

    # Show fleet status if anything is running
    if ls "$LOGDIR"/*.log &>/dev/null; then
        mini_status
    fi

    # Check for crashed sessions
    if [[ -f "$LOGDIR/last-session-status.txt" ]] && grep -q "^CRASHED" "$LOGDIR/last-session-status.txt" 2>/dev/null; then
        echo "  ⚡ Crashed session available:  bun develop --resume"
        echo ""
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
    SESSION_ID=$(bun -e "console.log(crypto.randomUUID())")
    echo "$SESSION_ID" > "$LOGDIR/last-session-state.txt"
    echo "CRASHED:$(date +%s)" > "$LOGDIR/last-session-status.txt"
    echo "→ Background run: $LOGDIR/$LOGNAME"
    echo "→ Session: $SESSION_ID"
    echo "→ Task: $PROMPT"
    echo ""

    (
        START=$(date +%s)
        set +e
        claude \
            --print \
            --dangerously-skip-permissions \
            --system-prompt "$SYSTEM_PROMPT" \
            --session-id "$SESSION_ID" \
            "$FULL_PROMPT" \
            > "$LOGDIR/$LOGNAME" 2>&1
        RC=$?
        END=$(date +%s)
        ELAPSED=$((END - START))
        echo "EXIT:$RC ELAPSED:${ELAPSED}s $(date '+%H:%M:%S')" > "$LOGDIR/${LOGNAME%.log}.done"
        if [[ "$RC" -eq 0 ]]; then
            echo "" >> "$LOGDIR/$LOGNAME"
            echo "═══ DONE (${ELAPSED}s) ═══" >> "$LOGDIR/$LOGNAME"
            echo "COMPLETED:$(date +%s)" > "$LOGDIR/last-session-status.txt"
        else
            echo "" >> "$LOGDIR/$LOGNAME"
            echo "═══ FAILED exit=$RC (${ELAPSED}s) ═══" >> "$LOGDIR/$LOGNAME"
            echo "── Resume with:  bun develop --resume ──" >> "$LOGDIR/$LOGNAME"
            echo "CRASHED:$(date +%s)" > "$LOGDIR/last-session-status.txt"
        fi
    ) &>/dev/null &

    PID=$!
    echo "   PID: $PID"
    echo ""

    sleep 2
    if kill -0 "$PID" 2>/dev/null; then
        echo "   ✓ Agent running. Use 'bun develop --watch' to follow."
        echo "   Result file:  $LOGDIR/${LOGNAME%.log}.done"
        echo "   Session:      $SESSION_ID"
        mini_status
    else
        echo "   ✗ Agent exited immediately — check the log:"
        echo ""
        tail -20 "$LOGDIR/$LOGNAME"
        if grep -q "CRASHED" "$LOGDIR/last-session-status.txt" 2>/dev/null; then
            echo ""
            echo "   ⚡ Resume with:  bun develop --resume"
        fi
    fi
elif $PRINT_MODE; then
    # ── Print mode (one-shot streaming) ───────────────────────────────────
    SESSION_ID=$(bun -e "console.log(crypto.randomUUID())")
    echo "$SESSION_ID" > "$LOGDIR/last-session-state.txt"
    echo "CRASHED:$(date +%s)" > "$LOGDIR/last-session-status.txt"
    echo "→ Task: $PROMPT"
    echo "→ Session: $SESSION_ID"
    echo "→ Mode: one-shot (--print)"
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
        --session-id "$SESSION_ID" \
        "$FULL_PROMPT" \
        2>&1 | bun run "$ROOT/scripts/stream-filter.ts"
    RC=${PIPESTATUS[0]}
    END=$(date +%s)
    ELAPSED=$((END - START))

    echo ""
    if [[ "$RC" -eq 0 ]]; then
        echo "COMPLETED:$(date +%s)" > "$LOGDIR/last-session-status.txt"
        echo "╔══════════════════════════════════════════════════════════════╗"
        echo "║  ✓  DONE  (${ELAPSED}s)                                          ║"
        echo "╚══════════════════════════════════════════════════════════════╝"
    else
        echo "╔══════════════════════════════════════════════════════════════╗"
        echo "║  ✗  FAILED (exit=$RC, ${ELAPSED}s)                                 ║"
        echo "╠══════════════════════════════════════════════════════════════╣"
        echo "║  ⚡ Resume:  bun develop --resume                            ║"
        echo "║  Session:   $SESSION_ID                                      ║"
        echo "╚══════════════════════════════════════════════════════════════╝"
    fi
    mini_status
    exit "$RC"
else
    # ── Foreground mode (interactive — stays alive) ───────────────────────
    SESSION_ID=$(bun -e "console.log(crypto.randomUUID())")
    echo "$SESSION_ID" > "$LOGDIR/last-session-state.txt"
    echo "CRASHED:$(date +%s)" > "$LOGDIR/last-session-status.txt"
    echo "→ Task: $PROMPT"
    echo "→ Session: $SESSION_ID"
    echo "→ Mode: interactive (session stays alive after task)"
    echo "→ Type your next prompt to continue, or Ctrl-C to exit"
    echo ""

    # Interactive mode: exec replaces the shell, session persists naturally.
    # User can keep iterating — type new prompts after each task completes.
    exec claude \
        --dangerously-skip-permissions \
        --system-prompt "$SYSTEM_PROMPT" \
        --session-id "$SESSION_ID" \
        "$FULL_PROMPT"
fi
