#!/usr/bin/env node
// ══════════════════════════════════════════════════════════
// Playwright Login Helper — Extract session tokens by
// logging in through a real browser window.
//
// Usage:
//   node playwright-login.js discord
//   node playwright-login.js instagram
//
// After login, automatically opens the client from a mirror
// URL with the token injected via URL hash. The hash fragment
// is never sent to any server — it stays client-side only.
//
// Designed for Acer Nitro N20C1 (modest hardware):
//   - Chromium only (saves ~1GB vs all browsers)
//   - GPU disabled, minimal resource usage
//   - Auto-closes login tab after token capture
// ══════════════════════════════════════════════════════════

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// ── Mirror URLs ───────────────────────────────────────────
// List of hosted mirrors for each client. The script will
// open the first reachable one after login. Replace
// https://example.com with real mirror URLs when available.
const MIRRORS = {
    discord: [
        'https://example.com/index.html',
        // Add more mirrors here, e.g.:
        // 'https://mirror2.example.com/index.html',
    ],
    instagram: [
        'https://example.com/insta/index.html',
        // Add more mirrors here, e.g.:
        // 'https://mirror2.example.com/insta/index.html',
    ]
};

const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const TOKENS_DIR = path.join(__dirname, 'tokens');

// ── Helpers ──────────────────────────────────────────────
function ensureTokensDir() {
    if (!fs.existsSync(TOKENS_DIR)) {
        fs.mkdirSync(TOKENS_DIR, { recursive: true });
    }
}

function saveToken(service, data) {
    ensureTokensDir();
    const filePath = path.join(TOKENS_DIR, `${service}.json`);
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    console.log(`Token saved to: ${filePath}`);
}

// Find first reachable mirror URL
async function getClientUrl(service) {
    const mirrors = MIRRORS[service] || [];
    for (const url of mirrors) {
        if (url.includes('example.com')) continue; // skip placeholder
        try {
            const controller = new AbortController();
            const t = setTimeout(() => controller.abort(), 3000);
            const res = await fetch(url, { signal: controller.signal, method: 'HEAD' });
            clearTimeout(t);
            if (res.ok) return url;
        } catch (_) {}
    }
    // Fall back to placeholder (will show an error page but that's expected)
    return mirrors[0] || null;
}

const LAUNCH_ARGS = [
    '--disable-gpu',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-sync',
    '--metrics-recording-only',
    '--no-first-run'
];

const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36';

// ── Discord Login ────────────────────────────────────────
async function loginDiscord() {
    console.log('\n--- Discord Login ---');
    console.log('A browser window will open to discord.com/login');
    console.log('Log in using any method (password, QR code, passkey).');
    console.log(`Auto-closes login tab after ${TIMEOUT_MS / 60000} minutes.\n`);

    const browser = await chromium.launch({ headless: false, args: LAUNCH_ARGS });
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, userAgent: CHROME_UA });
    const page = await context.newPage();
    let token = null;

    // Intercept API requests to capture the Authorization header
    page.on('request', (request) => {
        const url = request.url();
        if (url.includes('discord.com/api/') && !token) {
            const auth = request.headers()['authorization'];
            if (auth && auth.length > 20) {
                token = auth;
                console.log('Token captured from request headers!');
            }
        }
    });

    // Also check localStorage after login
    const tryLocalStorage = async () => {
        try {
            const val = await page.evaluate(() => {
                try {
                    return (webpackChunkdiscord_app.push([[''],{},e=>{let m;for(let c in e.c)if(e.c[c]?.exports?.default?.getToken){m=e.c[c].exports.default;break;}return m}]),undefined) || localStorage.getItem('token');
                } catch(_) { return localStorage.getItem('token'); }
            });
            if (val && !token) {
                token = val.replace(/^"(.*)"$/, '$1');
                console.log('Token extracted from localStorage!');
            }
        } catch (_) {}
    };

    const globalTimeout = setTimeout(async () => {
        console.log('\nTimeout reached. Closing browser.');
        await browser.close();
        process.exit(1);
    }, TIMEOUT_MS);

    try {
        await page.goto('https://discord.com/login', { waitUntil: 'domcontentloaded' });
        console.log('Browser opened. Please log in...');

        await page.waitForURL('**/channels/**', { timeout: TIMEOUT_MS });
        console.log('Login detected! Extracting token...');
        await page.waitForTimeout(2000);
        await tryLocalStorage();

        if (!token) {
            console.log('Could not auto-extract token. Trying DevTools method...');
            token = await page.evaluate(() => {
                try {
                    let t;
                    webpackChunkdiscord_app.push([[''],{},e=>{for(let c in e.c){const m=e.c[c]?.exports?.default;if(m?.getToken){t=m.getToken();break;}}}]);
                    return t || null;
                } catch(_) { return null; }
            });
            if (token) console.log('Token extracted via webpack!');
        }

        if (token) {
            saveToken('discord', { token, extracted: new Date().toISOString() });
            console.log(`Token: ${token.slice(0, 20)}...`);
            await openClientWithToken('discord', token, context, browser);
        } else {
            console.log('\nCould not extract token automatically.');
            console.log('Manually get it from DevTools > Console:');
            console.log('  (webpackChunkdiscord_app.push([[""],[],e=>{m=[];for(let c in e.c)m.push(e.c[c])}]),m).find(m=>m?.exports?.default?.getToken).exports.default.getToken()');
            console.log('\nPaste the token into the client login screen.');
            await new Promise(r => setTimeout(r, 30000)); // wait 30s before closing
        }
    } catch (err) {
        await tryLocalStorage();
        if (token) {
            saveToken('discord', { token, extracted: new Date().toISOString() });
            await openClientWithToken('discord', token, context, browser);
        } else {
            console.log('Login failed or timed out:', err.message);
        }
    } finally {
        clearTimeout(globalTimeout);
        await browser.close();
    }
}

// ── Instagram Login ──────────────────────────────────────
async function loginInstagram() {
    console.log('\n--- Instagram Login ---');
    console.log('A browser window will open to instagram.com/accounts/login');
    console.log('Log in normally. Handles captchas, 2FA, and challenges natively.');
    console.log(`Auto-closes login tab after ${TIMEOUT_MS / 60000} minutes.\n`);

    const browser = await chromium.launch({ headless: false, args: LAUNCH_ARGS });
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, userAgent: CHROME_UA });
    const page = await context.newPage();

    const globalTimeout = setTimeout(async () => {
        console.log('\nTimeout reached. Closing browser.');
        await browser.close();
        process.exit(1);
    }, TIMEOUT_MS);

    try {
        await page.goto('https://www.instagram.com/accounts/login/', { waitUntil: 'domcontentloaded' });
        console.log('Browser opened. Please log in...');

        // Wait for redirect away from login/challenge pages
        await page.waitForURL(url => {
            const p = new URL(url).pathname;
            return p === '/' || (
                !p.includes('/login') &&
                !p.includes('/challenge') &&
                !p.includes('/accounts/')
            );
        }, { timeout: TIMEOUT_MS });

        console.log('Login detected! Extracting session cookies...');
        await page.waitForTimeout(2000);

        const cookies = await context.cookies('https://www.instagram.com');
        const sessionCookie = cookies.find(c => c.name === 'sessionid');
        const csrfCookie = cookies.find(c => c.name === 'csrftoken');

        if (sessionCookie) {
            const data = {
                sessionId: sessionCookie.value,
                csrfToken: csrfCookie?.value || '',
                extracted: new Date().toISOString()
            };
            saveToken('instagram', data);
            console.log(`Session ID: ${sessionCookie.value.slice(0, 15)}...`);
            await openClientWithToken('instagram', data, context, browser);
        } else {
            console.log('\nCould not find sessionid cookie.');
            console.log('Try: DevTools > Application > Cookies > sessionid');
            await new Promise(r => setTimeout(r, 30000));
        }
    } catch (err) {
        // Try to extract cookies even after error
        const cookies = await context.cookies('https://www.instagram.com');
        const sessionCookie = cookies.find(c => c.name === 'sessionid');
        if (sessionCookie) {
            const data = {
                sessionId: sessionCookie.value,
                csrfToken: cookies.find(c => c.name === 'csrftoken')?.value || '',
                extracted: new Date().toISOString()
            };
            saveToken('instagram', data);
            await openClientWithToken('instagram', data, context, browser);
        } else {
            console.log('Login failed or timed out:', err.message);
        }
    } finally {
        clearTimeout(globalTimeout);
        await browser.close();
    }
}

// ── Open client with token injected via URL hash ──────────
async function openClientWithToken(service, tokenData, context, browser) {
    const clientUrl = await getClientUrl(service);

    if (!clientUrl) {
        console.log('\nNo mirror URL configured. Add mirror URLs to MIRRORS in playwright-login.js');
        console.log('Token is saved to tokens/' + service + '.json for manual use.');
        return;
    }

    // Encode token as URL hash — fragment never sent to server
    let hash;
    if (service === 'discord') {
        const token = typeof tokenData === 'string' ? tokenData : tokenData.token;
        hash = '#pl_token=' + encodeURIComponent(token);
    } else {
        const sessionId = typeof tokenData === 'object' ? tokenData.sessionId : tokenData;
        const csrfToken = typeof tokenData === 'object' ? (tokenData.csrfToken || '') : '';
        hash = '#pl_session=' + encodeURIComponent(sessionId) + '&pl_csrf=' + encodeURIComponent(csrfToken);
    }

    const fullUrl = clientUrl + hash;
    console.log(`\nOpening client at: ${clientUrl}`);
    console.log('Token injected via URL fragment (never sent to server).');

    // Open client in a new tab in the same browser context
    const clientPage = await context.newPage();
    await clientPage.goto(fullUrl, { waitUntil: 'domcontentloaded' });
    console.log('Client opened! Connecting automatically...');

    // Keep browser open until user closes it
    console.log('Close the browser when done.');
}

// ── Main ─────────────────────────────────────────────────
async function main() {
    const service = process.argv[2]?.toLowerCase();

    if (!service || !['discord', 'instagram'].includes(service)) {
        console.log('Usage: node playwright-login.js <discord|instagram>');
        console.log('');
        console.log('  discord    - Opens discord.com/login, extracts auth token,');
        console.log('               then opens the Discord client automatically');
        console.log('  instagram  - Opens instagram.com/login, extracts session,');
        console.log('               then opens the Instagram client automatically');
        console.log('');
        console.log('Prerequisites:');
        console.log('  npm install');
        console.log('  npx playwright install chromium');
        console.log('');
        console.log('Configure mirror URLs in the MIRRORS object at the top of this file.');
        process.exit(1);
    }

    try {
        if (service === 'discord') {
            await loginDiscord();
        } else {
            await loginInstagram();
        }
    } catch (err) {
        if (err.message?.includes("Executable doesn't exist") || err.message?.includes('browserType.launch')) {
            console.error('\nChromium not installed. Run:');
            console.error('  npx playwright install chromium');
            process.exit(1);
        }
        console.error('\nError:', err.message);
        process.exit(1);
    }
}

main();
