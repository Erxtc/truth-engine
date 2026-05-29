#!/usr/bin/env bash
# Batch-run claude agents from a list of prompts.
# Usage:
#   ./scripts/batch.sh prompts.txt                    # one prompt per line
#   ./scripts/batch.sh prompts.txt --parallel=3       # run 3 in parallel
#   ./scripts/batch.sh prompts.txt --dry-run           # just show what would run
#   echo "fix the fibonacci bug" | ./scripts/batch.sh -  # read from stdin
#
# Prompts file format:
#   - One prompt per line
#   - Lines starting with # are comments
#   - Blank lines are ignored
#   - Lines starting with @ reference a file to read as the prompt
#
# Each agent runs in this project directory with --dangerously-skip-permissions.
# Outputs are saved to logs/agent-batch/<timestamp>/<slug>.log

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"
cd "$ROOT"

# ── Config ──────────────────────────────────────────────────────────────────
PARALLEL=1
DRY_RUN=false
PROMPTS_FILE=""
CLAUDE_BIN="${CLAUDE_BIN:-claude}"

# ── Parse args ──────────────────────────────────────────────────────────────

while [[ $# -gt 0 ]]; do
    case "$1" in
        --parallel=*)
            PARALLEL="${1#--parallel=}"
            shift
            ;;
        --dry-run)
            DRY_RUN=true
            shift
            ;;
        -h|--help)
            echo "Usage: ./scripts/batch.sh [FILE|-] [--parallel=N] [--dry-run]"
            echo ""
            echo "  FILE          Path to prompts file (one per line), or - for stdin"
            echo "  --parallel=N  Max concurrent agents (default: 1)"
            echo "  --dry-run     Print what would run without executing"
            echo ""
            echo "Prompt file format:"
            echo "  # comments are ignored"
            echo "  blank lines are ignored"
            echo "  @path/to/file   reads prompt from that file"
            echo ""
            echo "Output: logs/agent-batch/<timestamp>/"
            exit 0
            ;;
        -*)
            echo "Unknown flag: $1"
            exit 1
            ;;
        *)
            PROMPTS_FILE="$1"
            shift
            ;;
    esac
done

if [[ -z "$PROMPTS_FILE" ]]; then
    echo "Error: no prompts file specified. Use - for stdin."
    echo "Usage: ./scripts/batch.sh [FILE|-] [--parallel=N] [--dry-run]"
    exit 1
fi

# ── Read prompts ────────────────────────────────────────────────────────────

PROMPTS=()
if [[ "$PROMPTS_FILE" == "-" ]]; then
    # Read from stdin
    while IFS= read -r line; do
        PROMPTS+=("$line")
    done
else
    if [[ ! -f "$PROMPTS_FILE" ]]; then
        echo "Error: file not found: $PROMPTS_FILE"
        exit 1
    fi
    while IFS= read -r line; do
        PROMPTS+=("$line")
    done < "$PROMPTS_FILE"
fi

# Filter out comments and blanks, resolve @file references
RESOLVED=()
for prompt in "${PROMPTS[@]}"; do
    # Skip comments and blanks
    [[ -z "$prompt" || "$prompt" =~ ^[[:space:]]*# ]] && continue
    prompt="${prompt#"${prompt%%[![:space:]]*}"}"  # trim leading
    prompt="${prompt%"${prompt##*[![:space:]]}"}"  # trim trailing
    # Resolve @file references
    if [[ "$prompt" =~ ^@(.+) ]]; then
        ref_file="${BASH_REMATCH[1]}"
        if [[ ! -f "$ref_file" ]]; then
            echo "Warning: referenced file not found: $ref_file — skipping"
            continue
        fi
        prompt="$(<"$ref_file")"
    fi
    RESOLVED+=("$prompt")
done

if [[ ${#RESOLVED[@]} -eq 0 ]]; then
    echo "No prompts found. Provide at least one non-comment, non-blank line."
    exit 1
fi

echo "→ ${#RESOLVED[@]} prompts loaded"
echo "→ parallelism: $PARALLEL"
echo ""

if $DRY_RUN; then
    echo "── Dry run ──"
    for i in "${!RESOLVED[@]}"; do
        echo "[$((i+1))/${#RESOLVED[@]}] ${RESOLVED[$i]}"
    done
    exit 0
fi

# ── Setup output dir ────────────────────────────────────────────────────────

TIMESTAMP=$(date +%Y%m%d-%H%M%S)
OUTDIR="logs/agent-batch/$TIMESTAMP"
mkdir -p "$OUTDIR"

echo "Output: $OUTDIR"
echo ""

# ── Slug helper ─────────────────────────────────────────────────────────────

slugify() {
    echo "$1" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+|-+$//g' | head -c 60
}

# ── Run a single agent ──────────────────────────────────────────────────────

run_agent() {
    local index="$1"
    local prompt="$2"
    local slug
    slug="$(slugify "$prompt")"
    [[ -z "$slug" ]] && slug="agent-$index"
    local logfile="$OUTDIR/${index}-${slug}.log"

    echo "[$index] START: $prompt"
    echo "       log: $logfile"

    local start_ts
    start_ts=$(date +%s)

    # Run claude in print mode (non-interactive) with permissions skipped
    if $CLAUDE_BIN \
        --print \
        --dangerously-skip-permissions \
        --no-session-persistence \
        --include-partial-messages \
        "$prompt" \
        > "$logfile" 2>&1; then
        local end_ts
        end_ts=$(date +%s)
        local elapsed=$((end_ts - start_ts))
        echo "[$index]   OK (${elapsed}s)"
        echo "OK:${elapsed}" > "$OUTDIR/${index}-${slug}.status"
    else
        local end_ts
        end_ts=$(date +%s)
        local elapsed=$((end_ts - start_ts))
        local exit_code=$?
        echo "[$index]   FAILED (exit=$exit_code, ${elapsed}s)"
        echo "FAIL:${exit_code}:${elapsed}" > "$OUTDIR/${index}-${slug}.status"
    fi
}

# ── Run sequentially ────────────────────────────────────────────────────────

if [[ "$PARALLEL" -le 1 ]]; then
    for i in "${!RESOLVED[@]}"; do
        run_agent "$((i+1))" "${RESOLVED[$i]}"
        echo ""
    done
else
    # ── Run with limited parallelism (background jobs + semaphore) ──────────
    RUNNING=0
    for i in "${!RESOLVED[@]}"; do
        # Wait if at capacity
        while [[ "$RUNNING" -ge "$PARALLEL" ]]; do
            wait -n 2>/dev/null || true
            RUNNING=$((RUNNING - 1))
        done
        run_agent "$((i+1))" "${RESOLVED[$i]}" &
        RUNNING=$((RUNNING + 1))
    done
    # Wait for remaining
    wait
fi

# ── Summary ─────────────────────────────────────────────────────────────────

echo "──────────────────────────────────────────────"
echo "Done. Results in: $OUTDIR"
echo ""
echo "Summary:"
OK_COUNT=0
FAIL_COUNT=0
for status_file in "$OUTDIR"/*.status; do
    [[ -f "$status_file" ]] || continue
    if grep -q "^OK" "$status_file"; then
        OK_COUNT=$((OK_COUNT + 1))
    else
        FAIL_COUNT=$((FAIL_COUNT + 1))
    fi
done
echo "  OK: $OK_COUNT  FAILED: $FAIL_COUNT  TOTAL: $((OK_COUNT + FAIL_COUNT))"
echo ""

# List failures
if [[ "$FAIL_COUNT" -gt 0 ]]; then
    echo "Failures:"
    for status_file in "$OUTDIR"/*.status; do
        [[ -f "$status_file" ]] || continue
        if ! grep -q "^OK" "$status_file"; then
            local name
            name="$(basename "$status_file" .status)"
            echo "  ✗ $OUTDIR/${name}.log"
        fi
    done
fi
