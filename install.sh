#!/bin/bash
# ══════════════════════════════════════════════════════════
# install.sh — One-click Playwright streaming server setup
#
# Run: bash install.sh
# Then: bash start.sh
# ══════════════════════════════════════════════════════════

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║  Playwright Streaming Server — Setup         ║"
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

# ── 4. Install ngrok ──────────────────────────────────────
install_ngrok() {
    echo ""
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
        echo ""
        echo "    IMPORTANT: ngrok requires a free auth token."
        echo "    Sign up at https://ngrok.com and run:"
        echo "      ngrok config add-authtoken <your-token>"
    else
        echo "[!] ngrok installation failed — install manually from https://ngrok.com/download"
    fi
}

install_ngrok

# ── 5. Save credentials to config.json ───────────────────
echo ""
echo "[*] Login credentials setup (optional — press Enter to skip)..."
echo "    Credentials are saved to config.json (gitignored) for auto-login."
echo ""

read -p "    Discord email    : " DISCORD_EMAIL
read -s -p "    Discord password : " DISCORD_PASS
echo ""
read -p "    Instagram username : " INSTA_USER
read -s -p "    Instagram password : " INSTA_PASS
echo ""

# Write config.json with whatever was provided (blanks = manual login)
cat > "$SCRIPT_DIR/config.json" << CONFIGEOF
{
  "_comment": "Fill in credentials for auto-login. Leave blank to log in manually.",
  "discord": {
    "email": $(printf '%s' "$DISCORD_EMAIL" | python3 -c "import json,sys; print(json.dumps(sys.stdin.read()))"),
    "password": $(printf '%s' "$DISCORD_PASS" | python3 -c "import json,sys; print(json.dumps(sys.stdin.read()))")
  },
  "instagram": {
    "username": $(printf '%s' "$INSTA_USER" | python3 -c "import json,sys; print(json.dumps(sys.stdin.read()))"),
    "password": $(printf '%s' "$INSTA_PASS" | python3 -c "import json,sys; print(json.dumps(sys.stdin.read()))")
  }
}
CONFIGEOF

echo "[OK] config.json saved"

# ── 6. Generate start.sh ──────────────────────────────────
echo ""
echo "[*] Generating start.sh..."

cat > "$SCRIPT_DIR/start.sh" << 'STARTEOF'
#!/bin/bash
# ══════════════════════════════════════════════════════════
# start.sh — Start Playwright server (Discord + Instagram)
#            + ngrok tunnel
#
# Usage: bash start.sh
# ══════════════════════════════════════════════════════════

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

PORT="${PORT:-3000}"

cleanup() {
    echo ""
    echo "Shutting down..."
    [ -n "$SERVER_PID" ] && kill $SERVER_PID 2>/dev/null
    [ -n "$NGROK_PID" ] && kill $NGROK_PID 2>/dev/null
    exit 0
}
trap cleanup SIGINT SIGTERM

echo ""
echo "Starting Playwright server (Discord + Instagram) on port $PORT..."
node playwright-server.js &
SERVER_PID=$!

# Wait for server to be ready
sleep 2
if ! kill -0 $SERVER_PID 2>/dev/null; then
    echo "[!] Server failed to start"
    exit 1
fi

echo "Starting ngrok tunnel..."
ngrok http "$PORT" --log=stdout --log-format=json > /tmp/ngrok-$$.log 2>&1 &
NGROK_PID=$!

# Wait for tunnel URL via ngrok local API
TUNNEL_URL=""
for i in $(seq 1 20); do
    sleep 1
    TUNNEL_URL=$(curl -s http://localhost:4040/api/tunnels 2>/dev/null \
        | grep -o '"public_url":"https://[^"]*"' | head -1 \
        | sed 's/"public_url":"//;s/"//')
    [ -n "$TUNNEL_URL" ] && break
done

echo ""
echo "╔══════════════════════════════════════════════════════════╗"
if [ -n "$TUNNEL_URL" ]; then
echo "║  Tunnel URL: $TUNNEL_URL"
echo "║                                                          ║"
echo "║  Discord   WS: $TUNNEL_URL/stream?type=discord            "
echo "║  Instagram WS: $TUNNEL_URL/stream?type=instagram        "
echo "║                                                          ║"
echo "║  Add this base URL to PLAYWRIGHT_MIRRORS in             "
echo "║  index.js (Discord) and insta/index.js (Instagram)      "
else
echo "║  Tunnel URL not detected — check ngrok is authenticated  ║"
echo "║  Run: ngrok config add-authtoken <your-token>            ║"
fi
echo "╚══════════════════════════════════════════════════════════╝"
echo ""
echo "Press Ctrl+C to stop."
echo ""

wait $SERVER_PID
cleanup
STARTEOF

chmod +x "$SCRIPT_DIR/start.sh"
echo "[OK] start.sh created"

# ── Done ──────────────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║  Setup complete!                                         ║"
echo "║                                                          ║"
echo "║  Start both servers:                                     ║"
echo "║    bash start.sh                                         ║"
echo "║                                                          ║"
echo "║  Both Discord and Instagram run simultaneously.          ║"
echo "║  The script prints an ngrok URL.                         ║"
echo "║  Add it to PLAYWRIGHT_MIRRORS in index.js + insta/index.js║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""
