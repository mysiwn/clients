#!/bin/bash
# ══════════════════════════════════════════════════════════
# contribute.sh — One-command mirror contribution
#
# Run: bash contribute.sh
#
# This script:
#   1. Checks/installs Node.js, dependencies, Chromium, ngrok
#   2. Checks for ngrok auth — prompts if missing
#   3. Starts Playwright server + ngrok tunnel
#   4. Auto-registers as a public mirror
#   5. Heartbeats every 25 min to stay listed
# ══════════════════════════════════════════════════════════

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

PROXY_BASE="https://cors-proxy.mysiwn.workers.dev"
PORT="${PORT:-3000}"
HEARTBEAT_INTERVAL=1500  # 25 minutes in seconds

echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║  Mirror Contribution — Setup                 ║"
echo "╚══════════════════════════════════════════════╝"
echo ""

# ── 1. Check Node.js ──────────────────────────────────────
check_node() {
    if command -v node &>/dev/null; then
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
    echo "[*] Installing Node.js via nvm..."
    if ! command -v curl &>/dev/null; then
        echo "[!] curl not found. Install curl first."
        exit 1
    fi
    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
    export NVM_DIR="$HOME/.nvm"
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
npm install --production 2>&1 | tail -3
echo "[OK] Dependencies installed"

# ── 3. Install Chromium via Playwright ────────────────────
echo ""
echo "[*] Installing Chromium browser..."
npx playwright install chromium 2>&1 | tail -5
echo "[OK] Chromium installed"

# ── 4. Check/install ngrok ────────────────────────────────
install_ngrok() {
    if command -v ngrok &>/dev/null; then
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
    curl -sL "$NGROK_URL" | tar xz -C /usr/local/bin/ 2>/dev/null || \
    ( mkdir -p "$HOME/.local/bin" && curl -sL "$NGROK_URL" | tar xz -C "$HOME/.local/bin/" && export PATH="$HOME/.local/bin:$PATH" )

    if command -v ngrok &>/dev/null; then
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
# Try to verify ngrok auth by checking config for authtoken
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
    read -p "    Enter your ngrok authtoken: " NGROK_TOKEN
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
    [ -n "$HEARTBEAT_PID" ] && kill $HEARTBEAT_PID 2>/dev/null
    [ -n "$SERVER_PID" ] && kill $SERVER_PID 2>/dev/null
    [ -n "$NGROK_PID" ] && kill $NGROK_PID 2>/dev/null
    exit 0
}
trap cleanup SIGINT SIGTERM

node playwright-server.js &
SERVER_PID=$!

sleep 2
if ! kill -0 $SERVER_PID 2>/dev/null; then
    echo "[!] Server failed to start"
    exit 1
fi
echo "[OK] Server running (PID $SERVER_PID)"

# ── 7. Start ngrok tunnel ────────────────────────────────
echo "[*] Starting ngrok tunnel..."
ngrok http "$PORT" --log=stdout --log-format=json > /tmp/ngrok-contribute-$$.log 2>&1 &
NGROK_PID=$!

# ── 8. Wait for tunnel URL ───────────────────────────────
TUNNEL_URL=""
for i in $(seq 1 20); do
    sleep 1
    TUNNEL_URL=$(curl -s http://localhost:4040/api/tunnels 2>/dev/null \
        | grep -o '"public_url":"https://[^"]*"' | head -1 \
        | sed 's/"public_url":"//;s/"//')
    [ -n "$TUNNEL_URL" ] && break
done

if [ -z "$TUNNEL_URL" ]; then
    echo "[!] Could not get ngrok tunnel URL."
    echo "    Check that ngrok is authenticated: ngrok config add-authtoken <token>"
    cleanup
fi

echo "[OK] Tunnel: $TUNNEL_URL"

# ── 9. Auto-register as mirror ───────────────────────────
echo ""
echo "[*] Registering as a public mirror..."

REGISTER_RESP=$(curl -s -X POST "$PROXY_BASE/mirrors/contribute" \
    -H "Content-Type: application/json" \
    -d "{\"url\": \"$TUNNEL_URL\"}" 2>&1)

if echo "$REGISTER_RESP" | grep -q '"ok":true'; then
    echo "[OK] Registered successfully!"
else
    echo "[!] Registration failed: $REGISTER_RESP"
    echo "    Your mirror is still running — users can connect directly with the URL above."
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
    while true; do
        sleep $HEARTBEAT_INTERVAL
        RESP=$(curl -s -X POST "$PROXY_BASE/mirrors/contribute" \
            -H "Content-Type: application/json" \
            -d "{\"url\": \"$TUNNEL_URL\"}" 2>&1)
        if echo "$RESP" | grep -q '"ok":true'; then
            echo "[heartbeat] Re-registered at $(date '+%H:%M:%S')"
        else
            echo "[heartbeat] Re-registration failed: $RESP"
        fi
    done
}

heartbeat &
HEARTBEAT_PID=$!

# Wait for server to exit
wait $SERVER_PID
cleanup
