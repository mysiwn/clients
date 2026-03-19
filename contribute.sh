#!/bin/sh
# ══════════════════════════════════════════════════════════
# contribute.sh — One-command mirror contribution
#
# Run: sh contribute.sh
#
# Usage: sh contribute.sh [--help]
#
# This script:
#   1. Checks/installs Node.js, dependencies, Chromium, ngrok
#   2. Checks for ngrok auth — prompts if missing
#   3. Starts Playwright server + ngrok tunnel
#   4. Auto-registers as a public mirror
#   5. Heartbeats every 25 min to stay listed
#
# Environment variables:
#   PORT            Playwright server port (default: 3000)
#   ROOT_SERVER     Optional backup mirror registry URL
#   NGROK_AUTHTOKEN Pre-set ngrok token (skips prompt)
# ══════════════════════════════════════════════════════════

# ── Help ──────────────────────────────────────────────────
if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
    echo ""
    echo "Usage: sh contribute.sh [--help]"
    echo ""
    echo "Starts a Playwright mirror server and registers it publicly."
    echo ""
    echo "Requirements (auto-installed if missing):"
    echo "  - Node.js 18+"
    echo "  - A free ngrok account — https://dashboard.ngrok.com/signup"
    echo ""
    echo "Environment variables:"
    echo "  PORT            Server port (default: 3000)"
    echo "  ROOT_SERVER     Backup registry URL (optional)"
    echo "  NGROK_AUTHTOKEN ngrok auth token (skips interactive prompt)"
    echo ""
    echo "From scratch on any machine:"
    echo "  git clone https://github.com/mysiwn/school"
    echo "  cd school"
    echo "  sh contribute.sh"
    echo ""
    exit 0
fi

set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

PROXY_BASE="https://cors-proxy.mysiwn.workers.dev"
ROOT_SERVER="${ROOT_SERVER:-}"
PORT="${PORT:-3000}"
HEARTBEAT_INTERVAL=1500  # 25 minutes
SERVER_PID=""
NGROK_PID=""
HEARTBEAT_PID=""

echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║  Mirror Contribution — Setup                 ║"
echo "╚══════════════════════════════════════════════╝"
echo ""
echo "This will install (if missing): Node.js 18+, npm deps, Chromium, ngrok"
echo ""

# ── Timer helper ──────────────────────────────────────────
_t0=""
timer_start() { _t0=$(date +%s 2>/dev/null || echo 0); }
timer_end() {
    _t1=$(date +%s 2>/dev/null || echo 0)
    echo "    (took $(( _t1 - _t0 ))s)"
}

# ── 1. Check / install Node.js ────────────────────────────
check_node() {
    if command -v node >/dev/null 2>&1; then
        NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
        if [ "$NODE_VER" -ge 18 ]; then
            echo "[OK] Node.js $(node -v)"
            return 0
        else
            echo "[!] Node.js $(node -v) is too old (need >= 18)"
        fi
    else
        echo "[!] Node.js not found"
    fi
    return 1
}

install_node() {
    timer_start
    if command -v apk >/dev/null 2>&1; then
        echo "[*] Installing Node.js via apk..."
        apk add --no-cache nodejs npm
    elif command -v apt-get >/dev/null 2>&1; then
        echo "[*] Installing Node.js via apt..."
        apt-get update -qq && apt-get install -y -qq nodejs npm
    elif command -v brew >/dev/null 2>&1; then
        echo "[*] Installing Node.js via Homebrew..."
        brew install node
    elif command -v curl >/dev/null 2>&1 && command -v bash >/dev/null 2>&1; then
        echo "[*] Installing Node.js via nvm..."
        curl --max-time 60 -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
        NVM_DIR="$HOME/.nvm"
        export NVM_DIR
        [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
        nvm install 20
        nvm use 20
    else
        echo "[!] No supported package manager found. Install Node.js 18+ manually: https://nodejs.org"
        exit 1
    fi
    echo "[OK] Node.js $(node -v) installed"
    timer_end
}

echo "[*] Checking Node.js..."
if ! check_node; then install_node; fi

# ── 2. npm install ────────────────────────────────────────
echo ""
echo "[*] Installing npm dependencies..."
# Skip if node_modules already in sync
_NM="$SCRIPT_DIR/server/node_modules"
_PKG="$SCRIPT_DIR/server/package-lock.json"
if [ -d "$_NM" ] && [ -f "$_PKG" ] && [ "$_NM" -nt "$_PKG" ] 2>/dev/null; then
    echo "[OK] node_modules up to date (skipping install)"
else
    timer_start
    cd "$SCRIPT_DIR/server" && npm install --production --prefer-offline 2>&1 | tail -3
    cd "$SCRIPT_DIR"
    echo "[OK] Dependencies installed"
    timer_end
fi

# ── 3. Install Chromium via Playwright ────────────────────
echo ""
echo "[*] Checking Chromium..."
# Skip download if Playwright already has chromium cached
_PW_CACHE="${PLAYWRIGHT_BROWSERS_PATH:-$HOME/.cache/ms-playwright}"
_CHROMIUM_EXISTS=false
if ls "$_PW_CACHE"/chromium-*/chrome-* >/dev/null 2>&1; then
    _CHROMIUM_EXISTS=true
fi
# On Alpine, prefer system chromium
if command -v apk >/dev/null 2>&1; then
    if ! command -v chromium-browser >/dev/null 2>&1 && ! command -v chromium >/dev/null 2>&1; then
        echo "[*] Installing system Chromium deps via apk..."
        apk add --no-cache chromium nss freetype harfbuzz ca-certificates ttf-freefont >/dev/null 2>&1 || true
    fi
    export PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH="${PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH:-/usr/bin/chromium-browser}"
    _CHROMIUM_EXISTS=true
fi
if [ "$_CHROMIUM_EXISTS" = true ]; then
    echo "[OK] Chromium already installed (skipping download)"
else
    echo "[*] Downloading Chromium (~150MB)..."
    timer_start
    cd "$SCRIPT_DIR/server" && npx playwright install chromium 2>&1 | tail -5
    cd "$SCRIPT_DIR"
    echo "[OK] Chromium installed"
    timer_end
fi

# ── 4. Check / install ngrok ─────────────────────────────
install_ngrok() {
    if command -v ngrok >/dev/null 2>&1; then
        echo "[OK] ngrok already installed ($(ngrok version 2>&1 | head -1))"
        return 0
    fi
    echo "[*] Installing ngrok..."
    ARCH=$(uname -m)
    OS=$(uname -s | tr '[:upper:]' '[:lower:]')
    case "$ARCH" in
        x86_64|amd64)  ARCH="amd64" ;;
        aarch64|arm64) ARCH="arm64" ;;
        armv7l|armhf)  ARCH="arm" ;;
        i686|i386)     ARCH="386" ;;
        *) echo "[!] Unsupported architecture: $ARCH"; exit 1 ;;
    esac
    NGROK_URL="https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-${OS}-${ARCH}.tgz"
    if curl --max-time 60 -sL "$NGROK_URL" | tar xz -C /usr/local/bin/ 2>/dev/null; then
        :
    else
        mkdir -p "$HOME/.local/bin"
        curl --max-time 60 -sL "$NGROK_URL" | tar xz -C "$HOME/.local/bin/"
        export PATH="$HOME/.local/bin:$PATH"
    fi
    if command -v ngrok >/dev/null 2>&1; then
        echo "[OK] ngrok installed"
    else
        echo "[!] ngrok installation failed — install manually from https://ngrok.com/download"
        exit 1
    fi
}

echo ""
install_ngrok

# Ensure ~/.local/bin is in PATH in case ngrok landed there
if [ -d "$HOME/.local/bin" ]; then
    case ":$PATH:" in
        *":$HOME/.local/bin:"*) ;;
        *) export PATH="$HOME/.local/bin:$PATH" ;;
    esac
fi

# ── 5. ngrok auth ─────────────────────────────────────────
echo ""
echo "[*] Checking ngrok authentication..."

NGROK_AUTHED=false
# Check config files first — no network calls, never hangs
if [ -f "$HOME/.config/ngrok/ngrok.yml" ] && grep -q "authtoken:" "$HOME/.config/ngrok/ngrok.yml" 2>/dev/null; then
    NGROK_AUTHED=true
elif [ -f "$HOME/.ngrok2/ngrok.yml" ] && grep -q "authtoken:" "$HOME/.ngrok2/ngrok.yml" 2>/dev/null; then
    NGROK_AUTHED=true
else
    # Fallback: ask ngrok where its config lives, then inspect that file
    _cfg=$(ngrok config check 2>/dev/null | grep -o '/[^ ]*\.yml' | head -1)
    if [ -n "$_cfg" ] && grep -q "authtoken:" "$_cfg" 2>/dev/null; then
        NGROK_AUTHED=true
    fi
fi

# Allow pre-setting token via environment variable
if [ "$NGROK_AUTHED" = false ] && [ -n "${NGROK_AUTHTOKEN:-}" ]; then
    ngrok config add-authtoken "$NGROK_AUTHTOKEN"
    NGROK_AUTHED=true
    echo "[OK] ngrok authenticated via NGROK_AUTHTOKEN env var"
fi

if [ "$NGROK_AUTHED" = false ]; then
    echo ""
    echo "    ngrok requires a free auth token to create tunnels."
    echo "    Sign up at  : https://dashboard.ngrok.com/signup"
    echo "    Your token  : https://dashboard.ngrok.com/get-started/your-authtoken"
    echo ""
    printf "    Enter your ngrok authtoken (90s timeout): "
    if read -t 90 -r NGROK_TOKEN 2>/dev/null; then
        :
    else
        echo ""
        echo "[!] No input received within 90 seconds."
        echo "    Re-run with: NGROK_AUTHTOKEN=<your-token> sh contribute.sh"
        exit 1
    fi
    if [ -z "$NGROK_TOKEN" ]; then
        echo "[!] No token provided. Cannot continue without ngrok auth."
        exit 1
    fi
    ngrok config add-authtoken "$NGROK_TOKEN"
    echo "[OK] ngrok authenticated"
else
    echo "[OK] ngrok already authenticated"
fi

# ── 6. Start Playwright server ────────────────────────────
echo ""
echo "[*] Starting Playwright server on port $PORT..."

cleanup() {
    echo ""
    echo "Shutting down..."
    [ -n "${HEARTBEAT_PID:-}" ] && kill "$HEARTBEAT_PID" 2>/dev/null || true
    [ -n "${SERVER_PID:-}" ]    && kill "$SERVER_PID"    2>/dev/null || true
    [ -n "${NGROK_PID:-}" ]     && kill "$NGROK_PID"     2>/dev/null || true
    wait 2>/dev/null || true
    exit 0
}
trap cleanup EXIT INT TERM

node server/playwright-server.js &
SERVER_PID=$!

# Wait for server with retries instead of fixed sleep
_server_ready=false
_retries=0
while [ "$_retries" -lt 15 ]; do
    sleep 1
    if ! kill -0 "$SERVER_PID" 2>/dev/null; then
        echo "[!] Server process died"
        exit 1
    fi
    if curl -s "http://localhost:${PORT}/status" >/dev/null 2>&1; then
        _server_ready=true
        break
    fi
    _retries=$((_retries + 1))
done
if [ "$_server_ready" = false ]; then
    echo "[!] Server started but not responding after 15s"
    exit 1
fi
echo "[OK] Server running (PID $SERVER_PID)"

# ── 7. Start ngrok tunnel ─────────────────────────────────
echo "[*] Starting ngrok tunnel..."
ngrok http "$PORT" --log=stdout --log-format=json > "/tmp/ngrok-contribute-$$.log" 2>&1 &
NGROK_PID=$!

# ── 8. Wait for tunnel URL ────────────────────────────────
TUNNEL_URL=""
i=0
while [ "$i" -lt 30 ]; do
    sleep 1
    TUNNEL_URL=$(curl -s http://localhost:4040/api/tunnels 2>/dev/null \
        | grep -o '"public_url":"https://[^"]*"' | head -1 \
        | sed 's/"public_url":"//;s/"//')
    if [ -n "$TUNNEL_URL" ]; then break; fi
    i=$((i + 1))
    if [ $((i % 5)) -eq 0 ]; then
        echo "    ...waiting for ngrok (${i}s)"
    fi
done

if [ -z "$TUNNEL_URL" ]; then
    echo "[!] Could not get ngrok tunnel URL after 30s."
    echo "    ngrok log: $(tail -5 /tmp/ngrok-contribute-$$.log 2>/dev/null || echo '(empty)')"
    echo "    Run: ngrok config add-authtoken <token>"
    exit 1
fi

case "$TUNNEL_URL" in
    https://*) ;;
    *) echo "[!] Unexpected tunnel URL format: $TUNNEL_URL"; exit 1 ;;
esac

echo "[OK] Tunnel: $TUNNEL_URL"

# ── 9. Register as mirror ─────────────────────────────────
echo ""
echo "[*] Registering as a public mirror..."

REGISTER_RESP=$(curl -s --max-time 15 -X POST "$PROXY_BASE/mirrors/contribute" \
    -H "Content-Type: application/json" \
    -d "{\"url\": \"$TUNNEL_URL\"}" 2>&1)

if echo "$REGISTER_RESP" | grep -q '"ok":true'; then
    echo "[OK] Registered with proxy!"
else
    echo "[!] Proxy registration response: $REGISTER_RESP"
    echo "    Mirror is still running — share the URL above directly."
fi

if [ -n "$ROOT_SERVER" ]; then
    ROOT_RESP=$(curl -s --max-time 15 -X POST "$ROOT_SERVER/mirrors/contribute" \
        -H "Content-Type: application/json" \
        -d "{\"url\": \"$TUNNEL_URL\"}" 2>&1)
    if echo "$ROOT_RESP" | grep -q '"ok":true'; then
        echo "[OK] Registered with root server ($ROOT_SERVER)"
    else
        echo "[!] Root server response: $ROOT_RESP"
    fi
fi

# ── 10. Success banner ────────────────────────────────────
_PADDED_URL="$TUNNEL_URL"
echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║  Mirror is live!                                         ║"
echo "║                                                          ║"
printf "║  URL: %-51s║\n" "$_PADDED_URL"
echo "║                                                          ║"
printf "║  Discord   WS: %-43s║\n" "$TUNNEL_URL/stream?type=discord"
printf "║  Instagram WS: %-43s║\n" "$TUNNEL_URL/stream?type=instagram"
echo "║                                                          ║"
echo "║  Heartbeat every 25 min to stay listed.                  ║"
echo "║  Press Ctrl+C to stop.                                   ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""

# ── 11. Heartbeat loop ────────────────────────────────────
heartbeat() {
    failures=0
    backoff=30
    while true; do
        sleep "$HEARTBEAT_INTERVAL"
        RESP=$(curl -s --max-time 15 -X POST "$PROXY_BASE/mirrors/contribute" \
            -H "Content-Type: application/json" \
            -d "{\"url\": \"$TUNNEL_URL\"}" 2>&1)
        if echo "$RESP" | grep -q '"ok":true'; then
            echo "[heartbeat] Re-registered at $(date '+%H:%M:%S')"
            failures=0
            backoff=30
        else
            failures=$((failures + 1))
            echo "[heartbeat] Attempt $failures failed: $RESP (retry in ${backoff}s)"
            sleep "$backoff"
            backoff=$(( backoff < 120 ? backoff * 2 : 120 ))
            # Try again immediately after backoff
            RESP2=$(curl -s --max-time 15 -X POST "$PROXY_BASE/mirrors/contribute" \
                -H "Content-Type: application/json" \
                -d "{\"url\": \"$TUNNEL_URL\"}" 2>&1)
            if echo "$RESP2" | grep -q '"ok":true'; then
                echo "[heartbeat] Retry succeeded"
                failures=0
                backoff=30
            elif [ "$failures" -ge 5 ]; then
                echo "[heartbeat] 5 failures — stopping heartbeat. Mirror still running at $TUNNEL_URL"
                return
            fi
        fi
        if [ -n "${ROOT_SERVER:-}" ]; then
            curl -s --max-time 15 -X POST "$ROOT_SERVER/mirrors/contribute" \
                -H "Content-Type: application/json" \
                -d "{\"url\": \"$TUNNEL_URL\"}" >/dev/null 2>&1 || true
        fi
    done
}

heartbeat &
HEARTBEAT_PID=$!

wait $SERVER_PID
cleanup
