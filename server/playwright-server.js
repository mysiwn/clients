#!/usr/bin/env node
// ══════════════════════════════════════════════════════════
// playwright-server.js — Discord + Instagram login server
//
// Runs both services simultaneously. Each gets its own
// browser instance with multi-tab support. Clients connect
// via query param:
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
const MAX_TABS = 5;                 // per service
const DEFAULT_TIMEOUT_S = 60;       // 1 minute idle timeout

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
        browser: null,
        context: null,
        pages: [],          // array of { page, id }
        activeTabIndex: 0,
        screenshotInterval: null,
        tokenCaptured: false,
        capturedToken: null,
        clients: new Set(),
        lastActivity: Date.now(),
        timeoutTimer: null,
        timeoutSeconds: DEFAULT_TIMEOUT_S
    },
    instagram: {
        browser: null,
        context: null,
        pages: [],
        activeTabIndex: 0,
        screenshotInterval: null,
        tokenCaptured: false,
        capturedSession: null,
        clients: new Set(),
        lastActivity: Date.now(),
        timeoutTimer: null,
        timeoutSeconds: DEFAULT_TIMEOUT_S
    }
};

// ── Helper: get active page ──────────────────────────────
function getActivePage(svc) {
    if (!svc.pages.length) return null;
    const idx = Math.min(svc.activeTabIndex, svc.pages.length - 1);
    return svc.pages[idx]?.page || null;
}

function getTabList(svc) {
    return svc.pages.map((t, i) => ({
        id: t.id,
        index: i,
        title: t.title || 'New Tab',
        active: i === svc.activeTabIndex
    }));
}

// ── Activity tracking & timeout ──────────────────────────
function touchActivity(svc, svcName) {
    svc.lastActivity = Date.now();
    resetTimeoutTimer(svc, svcName);
}

function resetTimeoutTimer(svc, svcName) {
    if (svc.timeoutTimer) clearTimeout(svc.timeoutTimer);
    if (svc.timeoutSeconds <= 0 || svc.tokenCaptured) return;
    svc.timeoutTimer = setTimeout(() => {
        if (svc.clients.size === 0) return;
        const idleSec = Math.floor((Date.now() - svc.lastActivity) / 1000);
        if (idleSec >= svc.timeoutSeconds) {
            console.log(`[${svcName}] Idle timeout (${idleSec}s) — disconnecting clients`);
            broadcast(svc, { type: 'timeout', message: `Disconnected after ${svc.timeoutSeconds}s of inactivity` });
            for (const ws of svc.clients) ws.close(1000, 'Idle timeout');
        }
    }, svc.timeoutSeconds * 1000);
}

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
            discord: {
                ready: !!getActivePage(SVC.discord),
                clients: SVC.discord.clients.size,
                captured: SVC.discord.tokenCaptured,
                hasCachedToken: !!SVC.discord.capturedToken,
                tabs: SVC.discord.pages.length
            },
            instagram: {
                ready: !!getActivePage(SVC.instagram),
                clients: SVC.instagram.clients.size,
                captured: SVC.instagram.tokenCaptured,
                hasCachedSession: !!SVC.instagram.capturedSession,
                tabs: SVC.instagram.pages.length
            }
        }));
        return;
    }

    res.writeHead(404); res.end('Not found');
});

// ── WebSocket Server ──────────────────────────────────────
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

    // Client can set timeout via query param (clamped to 0-3600)
    const clientTimeout = parseInt(parsed.searchParams.get('timeout'));
    if (!isNaN(clientTimeout) && clientTimeout >= 0) {
        svc.timeoutSeconds = Math.min(clientTimeout, 3600);
    }

    svc.clients.add(ws);
    touchActivity(svc, svcName);
    console.log(`[${svcName}] Client connected (${svc.clients.size} total)`);

    ws.on('close', () => {
        svc.clients.delete(ws);
        console.log(`[${svcName}] Client disconnected (${svc.clients.size} remaining)`);
        if (svc.clients.size === 0) {
            stopScreenshots(svc);
            if (svc.timeoutTimer) { clearTimeout(svc.timeoutTimer); svc.timeoutTimer = null; }
        }
    });

    ws.on('error', () => svc.clients.delete(ws));

    ws.on('message', async (raw) => {
        if (raw.length > 50000) return; // reject oversized messages
        let msg;
        try { msg = JSON.parse(raw); } catch (_) { return; }
        touchActivity(svc, svcName);

        // ── Tab management commands ──────────────────────
        if (msg.type === 'newtab') {
            if (svc.pages.length >= MAX_TABS) {
                send(ws, { type: 'error', message: `Max ${MAX_TABS} tabs reached` });
                return;
            }
            try {
                const page = await svc.context.newPage();
                const tabId = 'tab-' + Date.now();
                await page.goto(msg.url || URLS[svcName], { waitUntil: 'domcontentloaded' });
                const title = await page.title().catch(() => 'New Tab');
                svc.pages.push({ page, id: tabId, title });
                if (svcName === 'discord') setupDiscordCapture(svc, svc.pages.length - 1);
                else setupInstagramCapture(svc, svc.pages.length - 1);
                svc.activeTabIndex = svc.pages.length - 1;
                broadcast(svc, { type: 'tabs', tabs: getTabList(svc) });
                console.log(`[${svcName}] New tab opened: ${tabId}`);
            } catch (e) {
                send(ws, { type: 'error', message: 'Failed to open new tab: ' + e.message });
            }
            return;
        }

        if (msg.type === 'switchtab') {
            const idx = typeof msg.index === 'number' ? msg.index : -1;
            if (idx >= 0 && idx < svc.pages.length) {
                svc.activeTabIndex = idx;
                broadcast(svc, { type: 'tabs', tabs: getTabList(svc) });
                // Send immediate screenshot of new tab
                const page = getActivePage(svc);
                if (page) {
                    try {
                        const buf = await page.screenshot({ type: 'jpeg', quality: SCREENSHOT_QUALITY });
                        broadcast(svc, { type: 'screenshot', data: buf.toString('base64'), width: BROWSER_WIDTH, height: BROWSER_HEIGHT, tabIndex: svc.activeTabIndex });
                    } catch (_) {}
                }
            }
            return;
        }

        if (msg.type === 'closetab') {
            const idx = typeof msg.index === 'number' ? msg.index : svc.activeTabIndex;
            if (svc.pages.length <= 1) {
                send(ws, { type: 'error', message: 'Cannot close the last tab' });
                return;
            }
            if (idx >= 0 && idx < svc.pages.length) {
                const removed = svc.pages.splice(idx, 1)[0];
                try { removed.page.removeAllListeners(); await removed.page.close(); } catch (_) {}
                if (svc.activeTabIndex >= svc.pages.length) svc.activeTabIndex = svc.pages.length - 1;
                broadcast(svc, { type: 'tabs', tabs: getTabList(svc) });
                console.log(`[${svcName}] Tab closed: ${removed.id}`);
            }
            return;
        }

        if (msg.type === 'navigate') {
            const page = getActivePage(svc);
            if (page && msg.url) {
                try {
                    const parsed = new URL(msg.url);
                    if (!['http:', 'https:'].includes(parsed.protocol)) {
                        send(ws, { type: 'error', message: 'Invalid URL protocol' });
                        return;
                    }
                    await page.goto(msg.url, { waitUntil: 'domcontentloaded' });
                } catch (e) {
                    if (e instanceof TypeError) send(ws, { type: 'error', message: 'Invalid URL' });
                }
            }
            return;
        }

        if (msg.type === 'settimeout') {
            const t = parseInt(msg.seconds);
            if (!isNaN(t) && t >= 0) {
                svc.timeoutSeconds = t;
                resetTimeoutTimer(svc, svcName);
                broadcast(svc, { type: 'status', text: t > 0 ? `Timeout set to ${t}s` : 'Timeout disabled' });
            }
            return;
        }

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

        const page = getActivePage(svc);
        if (!page) return;
        await handleInput(svc, msg);
    });

    // Send initial state
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
    send(ws, { type: 'tabs', tabs: getTabList(svc) });
    send(ws, { type: 'config', timeout: svc.timeoutSeconds });

    const page = getActivePage(svc);
    if (page && !svc.tokenCaptured) {
        page.screenshot({ type: 'jpeg', quality: SCREENSHOT_QUALITY })
            .then(buf => send(ws, { type: 'screenshot', data: buf.toString('base64'), width: BROWSER_WIDTH, height: BROWSER_HEIGHT, tabIndex: svc.activeTabIndex }))
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
    const page = getActivePage(svc);
    if (!page) return;
    try {
        const bx = (msg.x ?? 0) * BROWSER_WIDTH;
        const by = (msg.y ?? 0) * BROWSER_HEIGHT;
        switch (msg.type) {
            case 'mousemove': await page.mouse.move(bx, by); break;
            case 'click':     await page.mouse.click(bx, by, { button: msg.button || 'left' }); break;
            case 'dblclick':  await page.mouse.dblclick(bx, by); break;
            case 'mousedown': await page.mouse.down({ button: msg.button || 'left' }); break;
            case 'mouseup':   await page.mouse.up({ button: msg.button || 'left' }); break;
            case 'scroll':    await page.mouse.wheel(msg.deltaX || 0, msg.deltaY || 0); break;
            case 'keydown':   if (msg.key) await page.keyboard.down(normalizeKey(msg.key)); break;
            case 'keyup':     if (msg.key) await page.keyboard.up(normalizeKey(msg.key)); break;
            case 'input':     if (msg.text) await page.keyboard.type(msg.text); break;
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
        if (!svc.pages.length || svc.clients.size === 0 || svc.tokenCaptured) return;
        const page = getActivePage(svc);
        if (!page) return;
        try {
            // Update tab title periodically
            const title = await page.title().catch(() => '');
            if (title && svc.pages[svc.activeTabIndex]) {
                svc.pages[svc.activeTabIndex].title = title;
            }
            const buf = await page.screenshot({ type: 'jpeg', quality: SCREENSHOT_QUALITY });
            broadcast(svc, { type: 'screenshot', data: buf.toString('base64'), width: BROWSER_WIDTH, height: BROWSER_HEIGHT, tabIndex: svc.activeTabIndex });
        } catch (_) {}
    }, SCREENSHOT_INTERVAL_MS);
}

function stopScreenshots(svc) {
    if (svc.screenshotInterval) { clearInterval(svc.screenshotInterval); svc.screenshotInterval = null; }
}

// ── Token extraction ──────────────────────────────────────
function setupDiscordCapture(svc, pageIndex) {
    const entry = svc.pages[pageIndex];
    if (!entry) return;
    entry.page.on('request', (request) => {
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

function setupInstagramCapture(svc, pageIndex) {
    const entry = svc.pages[pageIndex];
    if (!entry) return;
    let polling = false;

    // Periodically dismiss Instagram post-login dialogs ("Save login info",
    // "Turn on notifications") so the browser navigates to the home feed
    // and the session can be captured automatically.
    const dialogDismisser = setInterval(async () => {
        if (svc.tokenCaptured) { clearInterval(dialogDismisser); return; }
        try {
            const page = entry.page;
            // "Save login info" — click "Not Now"
            const notNow = page.locator('button:has-text("Not Now"), button:has-text("Not now")').first();
            if (await notNow.isVisible({ timeout: 500 }).catch(() => false)) {
                await notNow.click();
                console.log('[instagram] Dismissed "Save login info" dialog');
                return;
            }
            // "Turn on notifications" — click "Not Now"
            const notNow2 = page.locator('[role="dialog"] button:has-text("Not Now"), [role="dialog"] button:has-text("Not now")').first();
            if (await notNow2.isVisible({ timeout: 500 }).catch(() => false)) {
                await notNow2.click();
                console.log('[instagram] Dismissed notification dialog');
            }
        } catch (_) {}
    }, 1500);

    let capturePending = false;
    async function tryCapture() {
        if (svc.tokenCaptured || capturePending) return;
        capturePending = true;
        try {
            await entry.page.waitForTimeout(1500);
            const cookies = await svc.context.cookies('https://www.instagram.com');
            const sessionCookie = cookies.find(c => c.name === 'sessionid');
            const csrfCookie    = cookies.find(c => c.name === 'csrftoken');
            if (sessionCookie?.value) {
                clearInterval(dialogDismisser);
                svc.tokenCaptured = true;
                const fullCookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
                svc.capturedSession = {
                    sessionId: sessionCookie.value,
                    csrfToken: csrfCookie?.value || '',
                    fullCookies: fullCookieStr,
                    userAgent: CHROME_UA
                };
                stopScreenshots(svc);
                console.log('[instagram] Session captured! (' + cookies.length + ' cookies)');
                broadcast(svc, { type: 'session', ...svc.capturedSession });
                setTimeout(() => closeBrowser(svc, 'instagram'), 3000);
            }
        } catch (_) {}
        capturePending = false;
    }

    entry.page.on('framenavigated', async () => {
        if (svc.tokenCaptured) return;
        const url = entry.page.url();
        if (url.includes('/login') || url.includes('/challenge')) return;
        await tryCapture();
    });
}

// ── Browser lifecycle ─────────────────────────────────────
async function launchBrowser(svcName) {
    const svc = SVC[svcName];
    console.log(`[${svcName}] Launching Chromium...`);

    svc.browser = await chromium.launch({ headless: true, args: LAUNCH_ARGS });
    svc.context = await svc.browser.newContext({
        viewport: { width: BROWSER_WIDTH, height: BROWSER_HEIGHT },
        userAgent: CHROME_UA
    });
    const page = await svc.context.newPage();
    const tabId = 'tab-' + Date.now();
    svc.pages = [{ page, id: tabId, title: svcName }];
    svc.activeTabIndex = 0;

    if (svcName === 'discord') setupDiscordCapture(svc, 0);
    else setupInstagramCapture(svc, 0);

    console.log(`[${svcName}] Navigating to ${URLS[svcName]}...`);
    await page.goto(URLS[svcName], { waitUntil: 'domcontentloaded' });

    // Auto-fill if credentials are set
    if (svcName === 'discord' && CFG.discord.email && CFG.discord.password) {
        console.log('[discord] Auto-filling credentials...');
        try {
            await page.fill('input[name="email"]', CFG.discord.email);
            await page.fill('input[name="password"]', CFG.discord.password);
            await page.click('button[type="submit"]');
        } catch (_) { console.log('[discord] Auto-fill failed — waiting for manual login'); }
    } else if (svcName === 'instagram' && CFG.instagram.username && CFG.instagram.password) {
        console.log('[instagram] Auto-filling credentials...');
        try {
            await page.fill('input[name="username"]', CFG.instagram.username);
            await page.fill('input[name="password"]', CFG.instagram.password);
            await page.click('button[type="submit"]');
        } catch (_) { console.log('[instagram] Auto-fill failed — waiting for manual login'); }
    }

    broadcast(svc, { type: 'status', text: 'Browser ready — log in below' });
    broadcast(svc, { type: 'tabs', tabs: getTabList(svc) });
    startScreenshots(svc, svcName);
    console.log(`[${svcName}] Ready.`);
}

async function closeBrowser(svc, svcName) {
    stopScreenshots(svc);
    if (svc.timeoutTimer) { clearTimeout(svc.timeoutTimer); svc.timeoutTimer = null; }
    if (svc.browser) {
        try { await svc.browser.close(); } catch (_) {}
        svc.browser = null;
        svc.context = null;
        svc.pages = [];
        svc.activeTabIndex = 0;
    }
    console.log(`[${svcName}] Browser closed.`);
}

// ── Start ─────────────────────────────────────────────────
server.listen(PORT, async () => {
    console.log(`\nPlaywright streaming server on port ${PORT}`);
    console.log(`  Discord   → ws://localhost:${PORT}/stream?type=discord`);
    console.log(`  Instagram → ws://localhost:${PORT}/stream?type=instagram`);
    console.log(`  Status    → http://localhost:${PORT}/status`);
    console.log(`  Timeout   → ${DEFAULT_TIMEOUT_S}s (configurable per client)`);
    console.log(`  Max tabs  → ${MAX_TABS} per service`);
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
