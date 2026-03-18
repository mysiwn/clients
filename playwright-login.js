#!/usr/bin/env node
// ══════════════════════════════════════════════════════════
// Playwright Login Helper — Extract session tokens by
// logging in through a real browser window.
//
// Usage:
//   node playwright-login.js discord
//   node playwright-login.js instagram
//
// The user controls the browser — handles captchas, QR
// codes, 2FA, etc. Once logged in, the script extracts
// the session token and saves it locally.
//
// Designed for Acer Nitro N20C1 (modest hardware):
//   - Chromium only (saves ~1GB vs all browsers)
//   - GPU disabled, minimal resource usage
//   - Auto-closes after 5 minute timeout
// ══════════════════════════════════════════════════════════

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const TOKENS_DIR = path.join(__dirname, 'tokens');

// ── Helpers ──────────────────────────────────────────────
function ensureTokensDir() {
    if (!fs.existsSync(TOKENS_DIR)) {
        fs.mkdirSync(TOKENS_DIR, { recursive: true });
    }
}

function prompt(question) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(resolve => rl.question(question, answer => { rl.close(); resolve(answer); }));
}

function saveToken(service, data) {
    ensureTokensDir();
    const filePath = path.join(TOKENS_DIR, `${service}.json`);
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    console.log(`\nToken saved to: ${filePath}`);
    console.log('You can paste this into the client login screen.');
}

// ── Discord Login ────────────────────────────────────────
async function loginDiscord() {
    console.log('\n--- Discord Login ---');
    console.log('A browser window will open to discord.com/login');
    console.log('Log in using any method (password, QR code, passkey).');
    console.log(`Auto-closes after ${TIMEOUT_MS / 60000} minutes.\n`);

    const browser = await chromium.launch({
        headless: false,
        args: [
            '--disable-gpu',
            '--no-sandbox',
            '--disable-dev-shm-usage',
            '--disable-extensions',
            '--disable-background-networking',
            '--disable-sync',
            '--metrics-recording-only',
            '--no-first-run'
        ]
    });

    const context = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36'
    });

    const page = await context.newPage();
    let token = null;

    // Intercept API responses to catch the token
    page.on('response', async (response) => {
        const url = response.url();
        // After login, Discord fetches /api/v9/users/@me
        if (url.includes('/api/') && url.includes('/users/@me') && !url.includes('relationships') && !url.includes('settings')) {
            const req = response.request();
            const authHeader = req.headers()['authorization'];
            if (authHeader && !token) {
                token = authHeader;
                console.log('\nToken captured successfully!');
            }
        }
    });

    // Also try extracting from localStorage
    const checkLocalStorage = async () => {
        try {
            const result = await page.evaluate(() => {
                // Discord stores token in localStorage or webpackChunkdiscord_app
                const stored = localStorage.getItem('token');
                if (stored) return JSON.parse(stored);
                return null;
            });
            if (result && !token) {
                token = result;
                console.log('\nToken extracted from localStorage!');
            }
        } catch (_) {}
    };

    await page.goto('https://discord.com/login', { waitUntil: 'domcontentloaded' });
    console.log('Browser opened. Please log in...');

    // Wait for successful login (URL changes to /channels/ or /app)
    const timeout = setTimeout(async () => {
        console.log('\nTimeout reached. Closing browser.');
        await browser.close();
        process.exit(1);
    }, TIMEOUT_MS);

    try {
        await page.waitForURL('**/channels/**', { timeout: TIMEOUT_MS });
        console.log('\nLogin detected! Extracting token...');
        // Give a moment for API calls to complete
        await page.waitForTimeout(2000);
        await checkLocalStorage();

        if (token) {
            saveToken('discord', { token, extracted: new Date().toISOString() });
            console.log(`\nDiscord token: ${token.slice(0, 20)}...`);
        } else {
            console.log('\nCould not automatically extract token.');
            console.log('You can manually get it from browser DevTools:');
            console.log('  1. Press F12 > Console');
            console.log('  2. Type: (webpackChunkdiscord_app.push([[""],{},e=>{m=[];for(let c in e.c)m.push(e.c[c])}]),m).find(m=>m?.exports?.default?.getToken!==void 0).exports.default.getToken()');
            // Keep browser open for manual extraction
            await prompt('Press Enter to close the browser...');
        }
    } catch (err) {
        console.log('\nLogin timed out or navigation failed.');
        await checkLocalStorage();
        if (token) {
            saveToken('discord', { token, extracted: new Date().toISOString() });
        }
    } finally {
        clearTimeout(timeout);
        await browser.close();
    }
}

// ── Instagram Login ──────────────────────────────────────
async function loginInstagram() {
    console.log('\n--- Instagram Login ---');
    console.log('A browser window will open to instagram.com/accounts/login');
    console.log('Log in normally. The script will capture your session cookies.');
    console.log(`Auto-closes after ${TIMEOUT_MS / 60000} minutes.\n`);

    const browser = await chromium.launch({
        headless: false,
        args: [
            '--disable-gpu',
            '--no-sandbox',
            '--disable-dev-shm-usage',
            '--disable-extensions',
            '--disable-background-networking',
            '--disable-sync',
            '--metrics-recording-only',
            '--no-first-run'
        ]
    });

    const context = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36'
    });

    const page = await context.newPage();

    await page.goto('https://www.instagram.com/accounts/login/', { waitUntil: 'domcontentloaded' });
    console.log('Browser opened. Please log in...');

    const timeout = setTimeout(async () => {
        console.log('\nTimeout reached. Closing browser.');
        await browser.close();
        process.exit(1);
    }, TIMEOUT_MS);

    try {
        // Wait for redirect to feed (successful login)
        await page.waitForURL(url => {
            const path = new URL(url).pathname;
            return path === '/' || path.startsWith('/direct/') || (!path.includes('/login') && !path.includes('/challenge') && !path.includes('/accounts/'));
        }, { timeout: TIMEOUT_MS });

        console.log('\nLogin detected! Extracting session cookies...');
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
            console.log(`\nSession ID: ${sessionCookie.value.slice(0, 15)}...`);
            if (csrfCookie) console.log(`CSRF Token: ${csrfCookie.value.slice(0, 15)}...`);
        } else {
            console.log('\nCould not find session cookie.');
            console.log('You may need to manually copy the sessionid cookie from browser DevTools.');
            await prompt('Press Enter to close the browser...');
        }
    } catch (err) {
        console.log('\nLogin timed out or navigation failed.');
        // Try to extract cookies anyway
        const cookies = await context.cookies('https://www.instagram.com');
        const sessionCookie = cookies.find(c => c.name === 'sessionid');
        if (sessionCookie) {
            saveToken('instagram', {
                sessionId: sessionCookie.value,
                csrfToken: cookies.find(c => c.name === 'csrftoken')?.value || '',
                extracted: new Date().toISOString()
            });
        }
    } finally {
        clearTimeout(timeout);
        await browser.close();
    }
}

// ── Main ─────────────────────────────────────────────────
async function main() {
    const service = process.argv[2]?.toLowerCase();

    if (!service || !['discord', 'instagram'].includes(service)) {
        console.log('Usage: node playwright-login.js <discord|instagram>');
        console.log('');
        console.log('  discord    - Opens discord.com/login, extracts auth token');
        console.log('  instagram  - Opens instagram.com/login, extracts session cookies');
        console.log('');
        console.log('Prerequisites:');
        console.log('  npm install');
        console.log('  npx playwright install chromium');
        process.exit(1);
    }

    try {
        if (service === 'discord') {
            await loginDiscord();
        } else {
            await loginInstagram();
        }
    } catch (err) {
        if (err.message.includes('Executable doesn\'t exist') || err.message.includes('browserType.launch')) {
            console.error('\nChromium not installed. Run:');
            console.error('  npx playwright install chromium');
            process.exit(1);
        }
        console.error('\nError:', err.message);
        process.exit(1);
    }
}

main();
