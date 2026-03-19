#!/bin/sh
# ══════════════════════════════════════════════════════════
# contribute.sh — One-command mirror contribution
#
# Run: sh contribute.sh
#
# This script:
#   1. Checks/installs Node.js, dependencies, Chromium, ngrok
#   2. Checks for ngrok auth — prompts if missing
#   3. Starts Playwright server + ngrok tunnel
#   4. Auto-registers as a public mirror
#   5. Heartbeats every 25 min to stay listed
# ══════════════════════════════════════════════════════════

set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

PROXY_BASE="https://cors-proxy.mysiwn.workers.dev"
ROOT_SERVER="${ROOT_SERVER:-}"  # Optional: http://your-pi:8090
PORT="${PORT:-3000}"
HEARTBEAT_INTERVAL=1500  # 25 minutes in seconds
SERVER_PID=""
NGROK_PID=""
HEARTBEAT_PID=""

echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║  Mirror Contribution — Setup                 ║"
echo "╚══════════════════════════════════════════════╝"
echo ""

# ── 1. Check Node.js ──────────────────────────────────────
check_node() {
    if command -v node >/dev/null 2>&1; then
        NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
        if [ "$NODE_VER" -ge 18 ]; then
            echo "[OK] Node.js $(node -v) detected"
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
    # Alpine Linux
    if command -v apk >/dev/null 2>&1; then
        echo "[*] Installing Node.js via apk..."
        apk add --no-cache nodejs npm
        echo "[OK] Node.js $(node -v) installed via apk"
        return 0
    fi

    # Debian/Ubuntu
    if command -v apt-get >/dev/null 2>&1; then
        echo "[*] Installing Node.js via apt..."
        apt-get update -qq
        apt-get install -y -qq nodejs npm
        echo "[OK] Node.js $(node -v) installed via apt"
        return 0
    fi

    # macOS (Homebrew)
    if command -v brew >/dev/null 2>&1; then
        echo "[*] Installing Node.js via Homebrew..."
        brew install node
        echo "[OK] Node.js $(node -v) installed via brew"
        return 0
    fi

    # Fallback: nvm (requires bash)
    echo "[*] Installing Node.js via nvm..."
    if ! command -v curl >/dev/null 2>&1; then
        echo "[!] curl not found. Install curl first."
        exit 1
    fi
    if ! command -v bash >/dev/null 2>&1; then
        echo "[!] No supported package manager found. Install Node.js 18+ manually."
        exit 1
    fi
    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
    NVM_DIR="$HOME/.nvm"
    export NVM_DIR
    [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
    nvm install 20
    nvm use 20
    echo "[OK] Node.js $(node -v) installed via nvm"
}

if ! check_node; then
    install_node
fi

# ── 2. npm install ────────────────────────────────────────
echo ""
echo "[*] Installing npm dependencies..."
# Run in subshell; capture last 3 lines manually without pipefail risk
cd "$SCRIPT_DIR/server" && npm install --production 2>&1 | tail -3
cd "$SCRIPT_DIR"
echo "[OK] Dependencies installed"

# ── 3. Install Chromium via Playwright ────────────────────
echo ""
echo "[*] Installing Chromium browser..."
# Alpine needs Playwright deps installed via apk
if command -v apk >/dev/null 2>&1; then
    apk add --no-cache chromium nss freetype harfbuzz ca-certificates ttf-freefont >/dev/null 2>&1 || true
    export PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH="${PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH:-/usr/bin/chromium-browser}"
fi
cd "$SCRIPT_DIR/server" && npx playwright install chromium 2>&1 | tail -5
cd "$SCRIPT_DIR"
echo "[OK] Chromium installed"

# ── 4. Check/install ngrok ────────────────────────────────
install_ngrok() {
    if command -v ngrok >/dev/null 2>&1; then
        echo "[OK] ngrok already installed ($(ngrok version 2>&1 | head -1))"
        return 0
    fi

    echo "[*] Installing ngrok..."

    ARCH=$(uname -m)
    OS=$(uname -s | tr '[:upper:]' '[:lower:]')

    case "$ARCH" in
        x86_64|amd64) ARCH="amd64" ;;
        aarch64|arm64) ARCH="arm64" ;;
        armv7l|armhf) ARCH="arm" ;;
        *) echo "[!] Unsupported architecture: $ARCH"; exit 1 ;;
    esac

    NGROK_URL="https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-${OS}-${ARCH}.tgz"
    if curl -sL "$NGROK_URL" | tar xz -C /usr/local/bin/ 2>/dev/null; then
        :
    else
        mkdir -p "$HOME/.local/bin"
        curl -sL "$NGROK_URL" | tar xz -C "$HOME/.local/bin/"
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

# ── 5. Check ngrok auth — prompt if missing ───────────────
echo ""
echo "[*] Checking ngrok authentication..."

NGROK_AUTHED=false
if ngrok config check 2>/dev/null | grep -q "valid"; then
    NGROK_AUTHED=true
elif ngrok diagnose 2>/dev/null | grep -qi "authtoken.*ok"; then
    NGROK_AUTHED=true
elif [ -f "$HOME/.config/ngrok/ngrok.yml" ] && grep -q "authtoken:" "$HOME/.config/ngrok/ngrok.yml" 2>/dev/null; then
    NGROK_AUTHED=true
elif [ -f "$HOME/.ngrok2/ngrok.yml" ] && grep -q "authtoken:" "$HOME/.ngrok2/ngrok.yml" 2>/dev/null; then
    NGROK_AUTHED=true
fi

if [ "$NGROK_AUTHED" = false ]; then
    echo ""
    echo "    ngrok requires a free auth token to create tunnels."
    echo "    Sign up at https://dashboard.ngrok.com/signup"
    echo "    Then copy your authtoken from https://dashboard.ngrok.com/get-started/your-authtoken"
    echo ""
    printf "    Enter your ngrok authtoken: "
    read -r NGROK_TOKEN
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
    [ -n "${SERVER_PID:-}" ] && kill "$SERVER_PID" 2>/dev/null || true
    [ -n "${NGROK_PID:-}" ] && kill "$NGROK_PID" 2>/dev/null || true
    wait 2>/dev/null || true
    exit 0
}
trap cleanup EXIT INT TERM

node server/playwright-server.js &
SERVER_PID=$!

sleep 3
if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "[!] Server failed to start"
    exit 1
fi

if ! curl -s "http://localhost:${PORT}/status" >/dev/null 2>&1; then
    echo "[!] Server started but not responding to health check"
    exit 1
fi
echo "[OK] Server running (PID $SERVER_PID)"

# ── 7. Start ngrok tunnel ────────────────────────────────
echo "[*] Starting ngrok tunnel..."
ngrok http "$PORT" --log=stdout --log-format=json > "/tmp/ngrok-contribute-$$.log" 2>&1 &
NGROK_PID=$!

# ── 8. Wait for tunnel URL ───────────────────────────────
TUNNEL_URL=""
i=0
while [ "$i" -lt 20 ]; do
    sleep 1
    TUNNEL_URL=$(curl -s http://localhost:4040/api/tunnels 2>/dev/null \
        | grep -o '"public_url":"https://[^"]*"' | head -1 \
        | sed 's/"public_url":"//;s/"//')
    [ -n "$TUNNEL_URL" ] && break
    i=$((i + 1))
done

if [ -z "$TUNNEL_URL" ]; then
    echo "[!] Could not get ngrok tunnel URL."
    echo "    Check that ngrok is authenticated: ngrok config add-authtoken <token>"
    exit 1
fi

# Validate tunnel URL starts with https
case "$TUNNEL_URL" in
    https://*) ;;
    *) echo "[!] Invalid tunnel URL: $TUNNEL_URL"; exit 1 ;;
esac

echo "[OK] Tunnel: $TUNNEL_URL"

# ── 9. Auto-register as mirror ───────────────────────────
echo ""
echo "[*] Registering as a public mirror..."

REGISTER_RESP=$(curl -s -X POST "$PROXY_BASE/mirrors/contribute" \
    -H "Content-Type: application/json" \
    -d "{\"url\": \"$TUNNEL_URL\"}" 2>&1)

if echo "$REGISTER_RESP" | grep -q '"ok":true'; then
    echo "[OK] Registered with proxy successfully!"
else
    echo "[!] Proxy registration failed: $REGISTER_RESP"
    echo "    Your mirror is still running — users can connect directly with the URL above."
fi

if [ -n "$ROOT_SERVER" ]; then
    ROOT_RESP=$(curl -s -X POST "$ROOT_SERVER/mirrors/contribute" \
        -H "Content-Type: application/json" \
        -d "{\"url\": \"$TUNNEL_URL\"}" 2>&1)
    if echo "$ROOT_RESP" | grep -q '"ok":true'; then
        echo "[OK] Registered with root server ($ROOT_SERVER) successfully!"
    else
        echo "[!] Root server registration failed: $ROOT_RESP"
    fi
fi

# ── 10. Print success banner ─────────────────────────────
echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║  Mirror is live and registered!                          ║"
echo "║                                                          ║"
echo "║  URL: $TUNNEL_URL"
echo "║                                                          ║"
echo "║  Discord   WS: $TUNNEL_URL/stream?type=discord"
echo "║  Instagram WS: $TUNNEL_URL/stream?type=instagram"
echo "║                                                          ║"
echo "║  Heartbeat every 25 min to stay listed.                  ║"
echo "║  Press Ctrl+C to stop.                                   ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""

# ── 11. Heartbeat loop ───────────────────────────────────
heartbeat() {
    failures=0
    while true; do
        sleep "$HEARTBEAT_INTERVAL"
        RESP=$(curl -s -X POST "$PROXY_BASE/mirrors/contribute" \
            -H "Content-Type: application/json" \
            -d "{\"url\": \"$TUNNEL_URL\"}" 2>&1)
        if echo "$RESP" | grep -q '"ok":true'; then
            echo "[heartbeat] Re-registered at $(date '+%H:%M:%S')"
            failures=0
        else
            echo "[heartbeat] Re-registration failed: $RESP"
            failures=$((failures + 1))
            if [ "$failures" -ge 3 ]; then
                echo "[heartbeat] 3 consecutive failures — stopping heartbeat"
                return
            fi
        fi
        if [ -n "${ROOT_SERVER:-}" ]; then
            curl -s -X POST "$ROOT_SERVER/mirrors/contribute" \
                -H "Content-Type: application/json" \
                -d "{\"url\": \"$TUNNEL_URL\"}" >/dev/null 2>&1
        fi
    done
}

heartbeat &
HEARTBEAT_PID=$!

wait $SERVER_PID
cleanup
