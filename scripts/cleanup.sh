#!/usr/bin/env bash
# Clean up workspaces, old log sidecars, and temp files.
# Safe to run anytime — only removes generated files, never source code.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"
cd "$ROOT"

DRY_RUN=false
if [[ "${1:-}" == "--dry-run" ]]; then
    DRY_RUN=true
    shift
fi

cleaned=0

# ── Workspaces older than 1 hour ──────────────────────────────────────────────
if [[ -d workspaces ]]; then
    if $DRY_RUN; then
        count=$(find workspaces -maxdepth 1 -type d -mmin +60 | tail -n +2 | wc -l)
        echo "[dry-run] Would remove $count old workspaces"
    else
        count=$(find workspaces -maxdepth 1 -type d -mmin +60 | tail -n +2 | wc -l)
        find workspaces -maxdepth 1 -type d -mmin +60 -exec rm -rf {} + 2>/dev/null || true
        cleaned=$((cleaned + count))
    fi
fi

# ── Log sidecar files (.full.log) older than 7 days ────────────────────────────
if [[ -d logs ]]; then
    if $DRY_RUN; then
        count=$(find logs -name "*.full.log" -mtime +7 | wc -l)
        echo "[dry-run] Would remove $count old .full.log files"
    else
        count=$(find logs -name "*.full.log" -mtime +7 | wc -l)
        find logs -name "*.full.log" -mtime +7 -delete 2>/dev/null || true
        cleaned=$((cleaned + count))
    fi
fi

# ── Python __pycache__ and .pyc files ──────────────────────────────────────────
if $DRY_RUN; then
    count=$(find . -name "__pycache__" -type d -not -path "./node_modules/*" | wc -l)
    echo "[dry-run] Would remove $count __pycache__ dirs"
else
    find . -name "__pycache__" -type d -not -path "./node_modules/*" -exec rm -rf {} + 2>/dev/null || true
fi

if [[ "$DRY_RUN" == "false" ]]; then
    echo "Cleaned up $cleaned items."
    echo "Run with --dry-run to preview."
fi
