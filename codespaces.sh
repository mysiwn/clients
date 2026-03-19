#!/bin/bash
# ══════════════════════════════════════════════════════════
# codespaces.sh — GitHub Codespaces entry point
#
# Run: bash codespaces.sh
#
# This script:
#   1. Pulls the latest changes from GitHub (main branch)
#   2. Hands off to contribute.sh
# ══════════════════════════════════════════════════════════

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║  Codespaces — Updating from GitHub           ║"
echo "╚══════════════════════════════════════════════╝"
echo ""

# ── 1. Pull latest from GitHub ────────────────────────────
CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '')"

if [ -z "$CURRENT_BRANCH" ] || [ "$CURRENT_BRANCH" = "HEAD" ]; then
    echo "[!] Detached HEAD — skipping git pull"
else
    echo "[*] Current branch: $CURRENT_BRANCH"
    echo "[*] Fetching latest from origin..."
    if git fetch origin "$CURRENT_BRANCH" 2>&1; then
        BEHIND=$(git rev-list HEAD..origin/"$CURRENT_BRANCH" --count 2>/dev/null || echo 0)
        if [ "$BEHIND" -gt 0 ]; then
            git pull --ff-only origin "$CURRENT_BRANCH"
            echo "[OK] Updated ($BEHIND new commit(s))"
        else
            echo "[OK] Already up to date"
        fi
    else
        echo "[!] git fetch failed — continuing with local copy"
    fi
fi

echo ""

# ── 2. Hand off to contribute.sh ─────────────────────────
exec bash "$SCRIPT_DIR/contribute.sh"
