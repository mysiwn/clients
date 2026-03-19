#!/bin/sh
# ══════════════════════════════════════════════════════════
# codespaces.sh — Entry point for GitHub Codespaces / Alpine
#
# Run: sh codespaces.sh
#
# This script:
#   1. Installs git if missing (apk/apt/brew auto-detected)
#   2. Pulls the latest changes from GitHub (main branch)
#   3. Hands off to contribute.sh
# ══════════════════════════════════════════════════════════

set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║  Updating from GitHub                        ║"
echo "╚══════════════════════════════════════════════╝"
echo ""

# ── 0. Ensure git is available ────────────────────────────
if ! command -v git >/dev/null 2>&1; then
    echo "[*] git not found — installing..."
    if command -v apk >/dev/null 2>&1; then
        apk add --no-cache git
    elif command -v apt-get >/dev/null 2>&1; then
        apt-get update -qq && apt-get install -y -qq git
    elif command -v brew >/dev/null 2>&1; then
        brew install git
    else
        echo "[!] Cannot install git — no supported package manager found."
        echo "    Install git manually and re-run."
        exit 1
    fi
    echo "[OK] git installed"
fi

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
exec sh "$SCRIPT_DIR/contribute.sh"
