#!/usr/bin/env node
// ══════════════════════════════════════════════════════════
// playwright-server.js — Browser streaming login server
//
// Streams a real Playwright browser to the web client via
// WebSocket (screenshots + input forwarding). Once the user
// logs in, captures the token/session and sends it back.
//
// Usage:
//   node playwright-server.js --service discord
//   node playwright-server.js --service instagram
//
// Expose with Cloudflare Tunnel:
//   cloudflared tunnel --url http://localhost:3000
//
// Then add the trycloudflare.com URL to PLAYWRIGHT_MIRRORS
// in index.js / insta/index.js
// ══════════════════════════════════════════════════════════

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { chromium } = require('playwright');

// ── Config ───────────────────────────────────────────────
// Load credentials from config.json if present
const CONFIG_PATH = path.join(__dirname, 'config.json');
let CFG = { discord: { email: '', password: '' }, instagram: { username: '', password: '' } };
try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    CFG.discord.email    = raw.discord?.email    || '';
    CFG.discord.password = raw.discord?.password || '';
    CFG.instagram.username = raw.instagram?.username || '';
    CFG.instagram.password = raw.instagram?.password || '';
} catch (_) {}

const PORT = process.env.PORT || 3000;
const SERVICE = (() => {
    const idx = process.argv.indexOf('--service');
    const val = idx !== -1 ? process.argv[idx + 1]?.toLowerCase() : null;
    if (val !== 'discord' && val !== 'instagram') {
        console.error('Usage: node playwright-server.js --service discord|instagram');
        process.exit(1);
    }
    return val;
})();

const BROWSER_WIDTH = 1280;
const BROWSER_HEIGHT = 720;
const SCREENSHOT_INTERVAL_MS = 100; // 10fps
const SCREENSHOT_QUALITY = 70;      // JPEG quality (lower = less bandwidth)
const MAX_CLIENTS = 3;

const URLS = {
    discord: 'https://discord.com/login',
    instagram: 'https://www.instagram.com/accounts/login/'
};

const LAUNCH_ARGS = [
    '--disable-gpu',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-background-networking',
    '--disable-sync',
    '--no-first-run',
    '--disable-extensions'
];

// ── State ─────────────────────────────────────────────────
let browser = null;
let page = null;
let screenshotInterval = null;
let tokenCaptured = false;
const clients = new Set();

// ── HTTP Server (health check + CORS) ────────────────────
const server = http.createServer((req, res) => {
    // CORS headers — allow client pages to reach this server
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(204); res.end(); return;
    }

    if (req.url === '/status' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, service: SERVICE, clients: clients.size }));
        return;
    }

    res.writeHead(404); res.end('Not found');
});

// ── WebSocket Server ──────────────────────────────────────
const wss = new WebSocketServer({ server, path: '/stream' });

wss.on('connection', (ws, req) => {
    if (clients.size >= MAX_CLIENTS) {
        ws.close(1013, 'Too many clients');
        return;
    }

    clients.add(ws);
    console.log(`Client connected (${clients.size} total) from ${req.socket.remoteAddress}`);

    ws.on('close', () => {
        clients.delete(ws);
        console.log(`Client disconnected (${clients.size} remaining)`);
    });

    ws.on('error', () => clients.delete(ws));

    ws.on('message', async (raw) => {
        if (!page) return;
        let msg;
        try { msg = JSON.parse(raw); } catch (_) { return; }
        await handleClientInput(msg);
    });

    // Send current status
    send(ws, { type: 'status', text: tokenCaptured ? 'Login already completed' : 'Connected — log in to continue' });

    // If already have a browser page, send a screenshot immediately
    if (page && !tokenCaptured) {
        page.screenshot({ type: 'jpeg', quality: SCREENSHOT_QUALITY })
            .then(buf => send(ws, { type: 'screenshot', data: buf.toString('base64'), width: BROWSER_WIDTH, height: BROWSER_HEIGHT }))
            .catch(() => {});
    }
});

function send(ws, data) {
    if (ws.readyState === ws.OPEN) {
        try { ws.send(JSON.stringify(data)); } catch (_) {}
    }
}

function broadcast(data) {
    const json = JSON.stringify(data);
    for (const ws of clients) {
        if (ws.readyState === ws.OPEN) {
            try { ws.send(json); } catch (_) {}
        }
    }
}

// ── Input handling ────────────────────────────────────────
async function handleClientInput(msg) {
    if (!page) return;
    try {
        // Normalize coordinates (0-1) → browser viewport pixels
        const bx = (msg.x ?? 0) * BROWSER_WIDTH;
        const by = (msg.y ?? 0) * BROWSER_HEIGHT;

        switch (msg.type) {
            case 'mousemove':
                await page.mouse.move(bx, by);
                break;
            case 'click':
                await page.mouse.click(bx, by, { button: msg.button || 'left' });
                break;
            case 'dblclick':
                await page.mouse.dblclick(bx, by);
                break;
            case 'mousedown':
                await page.mouse.down({ button: msg.button || 'left' });
                break;
            case 'mouseup':
                await page.mouse.up({ button: msg.button || 'left' });
                break;
            case 'scroll':
                await page.mouse.wheel(msg.deltaX || 0, msg.deltaY || 0);
                break;
            case 'keydown':
                if (msg.key) await page.keyboard.down(normalizeKey(msg.key));
                break;
            case 'keyup':
                if (msg.key) await page.keyboard.up(normalizeKey(msg.key));
                break;
            case 'input':
                // Type text directly (handles paste-like input)
                if (msg.text) await page.keyboard.type(msg.text);
                break;
        }
    } catch (err) {
        // Input errors are non-fatal — just ignore
    }
}

// Normalize browser key names to Playwright key names
function normalizeKey(key) {
    const map = {
        ' ': 'Space',
        'ArrowLeft': 'ArrowLeft',
        'ArrowRight': 'ArrowRight',
        'ArrowUp': 'ArrowUp',
        'ArrowDown': 'ArrowDown',
        'Backspace': 'Backspace',
        'Delete': 'Delete',
        'Enter': 'Enter',
        'Tab': 'Tab',
        'Escape': 'Escape',
        'Shift': 'Shift',
        'Control': 'Control',
        'Alt': 'Alt',
        'Meta': 'Meta',
        'CapsLock': 'CapsLock',
        'Home': 'Home',
        'End': 'End',
        'PageUp': 'PageUp',
        'PageDown': 'PageDown',
    };
    return map[key] || key;
}

// ── Screenshot loop ───────────────────────────────────────
function startScreenshotLoop() {
    if (screenshotInterval) return;
    screenshotInterval = setInterval(async () => {
        if (!page || clients.size === 0 || tokenCaptured) return;
        try {
            const buf = await page.screenshot({ type: 'jpeg', quality: SCREENSHOT_QUALITY });
            broadcast({ type: 'screenshot', data: buf.toString('base64'), width: BROWSER_WIDTH, height: BROWSER_HEIGHT });
        } catch (_) {
            // Page may be navigating — ignore
        }
    }, SCREENSHOT_INTERVAL_MS);
}

function stopScreenshotLoop() {
    if (screenshotInterval) {
        clearInterval(screenshotInterval);
        screenshotInterval = null;
    }
}

// ── Token extraction — Discord ────────────────────────────
function setupDiscordCapture() {
    page.on('request', (request) => {
        if (tokenCaptured) return;
        const url = request.url();
        if (!url.includes('discord.com/api/')) return;
        const auth = request.headers()['authorization'];
        if (auth && auth.length > 20 && !auth.startsWith('undefined')) {
            tokenCaptured = true;
            stopScreenshotLoop();
            console.log('Discord token captured!');
            broadcast({ type: 'token', token: auth });
            // Close browser after short delay
            setTimeout(() => closeBrowser(), 3000);
        }
    });
}

// ── Token extraction — Instagram ──────────────────────────
function setupInstagramCapture() {
    // Poll for sessionid cookie after URL changes
    let polling = false;
    page.on('framenavigated', async () => {
        if (tokenCaptured || polling) return;
        const url = page.url();
        const isLoginPage = url.includes('/login') || url.includes('/challenge') || url.includes('/accounts/');
        if (isLoginPage) return;
        polling = true;
        try {
            await page.waitForTimeout(1500); // let cookies settle
            const cookies = await page.context().cookies('https://www.instagram.com');
            const sessionCookie = cookies.find(c => c.name === 'sessionid');
            const csrfCookie = cookies.find(c => c.name === 'csrftoken');
            if (sessionCookie?.value) {
                tokenCaptured = true;
                stopScreenshotLoop();
                console.log('Instagram session captured!');
                broadcast({
                    type: 'session',
                    sessionId: sessionCookie.value,
                    csrfToken: csrfCookie?.value || ''
                });
                setTimeout(() => closeBrowser(), 3000);
            }
        } catch (_) {}
        polling = false;
    });
}

// ── Browser lifecycle ─────────────────────────────────────
async function launchBrowser() {
    console.log(`Launching Chromium for ${SERVICE}...`);
    browser = await chromium.launch({
        headless: true, // headless on server — user sees via stream
        args: LAUNCH_ARGS
    });
    const context = await browser.newContext({
        viewport: { width: BROWSER_WIDTH, height: BROWSER_HEIGHT },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36'
    });
    page = await context.newPage();

    // Set up token capture before navigating
    if (SERVICE === 'discord') setupDiscordCapture();
    else setupInstagramCapture();

    console.log(`Navigating to ${URLS[SERVICE]}...`);
    await page.goto(URLS[SERVICE], { waitUntil: 'domcontentloaded' });

    // Auto-fill credentials if configured
    if (SERVICE === 'discord' && CFG.discord.email && CFG.discord.password) {
        console.log('Auto-filling Discord credentials...');
        try {
            await page.fill('input[name="email"]', CFG.discord.email);
            await page.fill('input[name="password"]', CFG.discord.password);
            await page.click('button[type="submit"]');
        } catch (_) { console.log('Auto-fill failed — waiting for manual login'); }
    } else if (SERVICE === 'instagram' && CFG.instagram.username && CFG.instagram.password) {
        console.log('Auto-filling Instagram credentials...');
        try {
            await page.fill('input[name="username"]', CFG.instagram.username);
            await page.fill('input[name="password"]', CFG.instagram.password);
            await page.click('button[type="submit"]');
        } catch (_) { console.log('Auto-fill failed — waiting for manual login'); }
    }

    broadcast({ type: 'status', text: 'Browser ready — log in below' });
    startScreenshotLoop();
    console.log('Browser ready. Screenshot loop started.');
}

async function closeBrowser() {
    stopScreenshotLoop();
    if (browser) {
        try { await browser.close(); } catch (_) {}
        browser = null;
        page = null;
    }
    console.log('Browser closed.');
}

// ── Start ─────────────────────────────────────────────────
server.listen(PORT, async () => {
    console.log(`\nPlaywright streaming server running on port ${PORT}`);
    console.log(`Service: ${SERVICE}`);
    console.log(`Health: http://localhost:${PORT}/status`);
    console.log(`\nExpose with Cloudflare Tunnel:`);
    console.log(`  cloudflared tunnel --url http://localhost:${PORT}`);
    console.log(`\nThen add the trycloudflare.com URL to PLAYWRIGHT_MIRRORS in index.js\n`);

    try {
        await launchBrowser();
    } catch (err) {
        if (err.message?.includes("Executable doesn't exist")) {
            console.error('\nChromium not installed. Run:');
            console.error('  npx playwright install chromium');
            process.exit(1);
        }
        console.error('Failed to launch browser:', err.message);
        process.exit(1);
    }
});

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('\nShutting down...');
    await closeBrowser();
    server.close();
    process.exit(0);
});
