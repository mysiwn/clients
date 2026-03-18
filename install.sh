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

# ── 4. Install cloudflared ────────────────────────────────
install_cloudflared() {
    echo ""
    if command -v cloudflared &>/dev/null; then
        echo "[OK] cloudflared already installed ($(cloudflared --version 2>&1 | head -1))"
        return 0
    fi

    echo "[*] Installing cloudflared (Cloudflare Tunnel)..."

    ARCH=$(uname -m)
    OS=$(uname -s | tr '[:upper:]' '[:lower:]')

    case "$ARCH" in
        x86_64|amd64) ARCH="amd64" ;;
        aarch64|arm64) ARCH="arm64" ;;
        armv7l|armhf) ARCH="arm" ;;
        *) echo "[!] Unsupported architecture: $ARCH"; exit 1 ;;
    esac

    if [ "$OS" = "linux" ]; then
        CF_URL="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${ARCH}"
        curl -sL "$CF_URL" -o /usr/local/bin/cloudflared 2>/dev/null || \
        curl -sL "$CF_URL" -o "$HOME/.local/bin/cloudflared" && mkdir -p "$HOME/.local/bin"
        chmod +x /usr/local/bin/cloudflared 2>/dev/null || chmod +x "$HOME/.local/bin/cloudflared"
        export PATH="$HOME/.local/bin:$PATH"
    elif [ "$OS" = "darwin" ]; then
        if command -v brew &>/dev/null; then
            brew install cloudflared
        else
            CF_URL="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-${ARCH}.tgz"
            curl -sL "$CF_URL" | tar xz -C /usr/local/bin/
        fi
    else
        echo "[!] Unsupported OS: $OS"
        echo "    Install cloudflared manually: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
        return 1
    fi

    if command -v cloudflared &>/dev/null; then
        echo "[OK] cloudflared installed"
    else
        echo "[!] cloudflared installation failed — install manually"
        echo "    https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
    fi
}

install_cloudflared

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
#            + Cloudflare Tunnel
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
    [ -n "$CF_PID" ] && kill $CF_PID 2>/dev/null
    rm -f /tmp/cf-tunnel-$$.log
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

echo "Starting Cloudflare Tunnel..."
cloudflared tunnel --url "http://localhost:$PORT" 2>&1 | tee /tmp/cf-tunnel-$$.log &
CF_PID=$!

# Wait for tunnel URL to appear
for i in $(seq 1 15); do
    TUNNEL_URL=$(grep -o 'https://[^ ]*trycloudflare.com' /tmp/cf-tunnel-$$.log 2>/dev/null | head -1)
    if [ -n "$TUNNEL_URL" ]; then break; fi
    sleep 1
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
echo "║  Tunnel URL not detected yet — check the logs above      ║"
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
echo "║  The script prints a trycloudflare.com URL.              ║"
echo "║  Add it to PLAYWRIGHT_MIRRORS in index.js + insta/index.js║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""
