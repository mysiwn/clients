#!/usr/bin/env node
// ══════════════════════════════════════════════════════════
// root-server.js — Backup mirror registry for Pi
//
// A lightweight server that maintains the mirror registry
// independently of Cloudflare Workers. Run this on a Pi or
// any always-on machine as a fallback.
//
// Usage:
//   node root-server.js
//   PORT=8080 node root-server.js
//
// Endpoints:
//   GET  /mirrors           — list available mirrors
//   POST /mirrors/register  — register a mirror (requires secret)
//   POST /mirrors/contribute — self-register (no auth, short TTL)
//   DELETE /mirrors          — remove a mirror (requires secret)
//   GET  /status             — health check
// ══════════════════════════════════════════════════════════

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8090;
const MIRROR_SECRET = process.env.MIRROR_SECRET || '';
const DATA_FILE = path.join(__dirname, 'mirrors-db.json');

// ── In-memory mirror store with TTL ─────────────────────
// { url: string, registeredAt: string, expiresAt: number, contributed: boolean }
let mirrors = new Map();

// Load persisted mirrors from disk
function loadMirrors() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
            const now = Date.now();
            for (const entry of data) {
                if (entry.expiresAt > now) {
                    mirrors.set(entry.url, entry);
                }
            }
            console.log(`Loaded ${mirrors.size} mirror(s) from disk`);
        }
    } catch (e) {
        console.warn('Failed to load mirrors from disk:', e.message);
    }
}

// Persist mirrors to disk (debounced to avoid excessive I/O)
let _saveTimeout = null;
function saveMirrors() {
    if (_saveTimeout) return;
    _saveTimeout = setTimeout(() => {
        _saveTimeout = null;
        try {
            const data = [...mirrors.values()];
            fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
        } catch (e) {
            console.warn('Failed to save mirrors to disk:', e.message);
        }
    }, 1000);
}

// Force immediate save (for shutdown)
function saveMirrorsSync() {
    if (_saveTimeout) { clearTimeout(_saveTimeout); _saveTimeout = null; }
    try {
        const data = [...mirrors.values()];
        fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
    } catch (e) {
        console.warn('Failed to save mirrors to disk:', e.message);
    }
}

// Prune expired entries every 60 seconds
setInterval(() => {
    const now = Date.now();
    let pruned = 0;
    for (const [url, entry] of mirrors) {
        if (entry.expiresAt <= now) {
            mirrors.delete(url);
            pruned++;
        }
    }
    if (pruned > 0) {
        console.log(`Pruned ${pruned} expired mirror(s), ${mirrors.size} remaining`);
        saveMirrors();
    }
}, 60000);

// ── Health check for mirror ─────────────────────────────
async function checkMirrorHealth(url) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
        const statusUrl = url.replace(/\/+$/, '') + '/status';
        const res = await fetch(statusUrl, { signal: controller.signal, redirect: 'error' });
        if (!res.ok) return false;
        const data = await res.json();
        return data.ok === true;
    } catch {
        return false;
    } finally {
        clearTimeout(timeout);
    }
}

// ── CORS headers ────────────────────────────────────────
function corsHeaders() {
    return {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '86400'
    };
}

function jsonResponse(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json', ...corsHeaders() });
    res.end(JSON.stringify(data));
}

// ── Parse JSON body ─────────────────────────────────────
function parseBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => {
            body += chunk;
            if (body.length > 1024 * 10) { reject(new Error('Body too large')); req.destroy(); }
        });
        req.on('end', () => {
            try { resolve(JSON.parse(body)); }
            catch { reject(new Error('Invalid JSON')); }
        });
        req.on('error', reject);
    });
}

// ── Validate URL ────────────────────────────────────────
function isValidMirrorUrl(url) {
    try {
        const parsed = new URL(url);
        return parsed.protocol === 'https:' ||
               parsed.hostname.endsWith('.ngrok-free.app') ||
               parsed.hostname.endsWith('.ngrok.io') ||
               parsed.hostname === 'localhost' ||
               parsed.hostname.startsWith('192.168.') ||
               parsed.hostname.startsWith('10.');
    } catch { return false; }
}

// ── HTTP Server ─────────────────────────────────────────
const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const pathname = url.pathname.replace(/\/+$/, '') || '/';

    // CORS preflight
    if (req.method === 'OPTIONS') {
        res.writeHead(204, corsHeaders());
        res.end();
        return;
    }

    // Health check
    if (pathname === '/status' && req.method === 'GET') {
        jsonResponse(res, 200, { ok: true, mirrors: mirrors.size, uptime: process.uptime() });
        return;
    }

    // GET /mirrors — list all live mirrors
    if (pathname === '/mirrors' && req.method === 'GET') {
        const now = Date.now();
        const urls = [];
        for (const [url, entry] of mirrors) {
            if (entry.expiresAt > now) urls.push(url);
        }
        jsonResponse(res, 200, { mirrors: urls });
        return;
    }

    // POST /mirrors/register — auth-protected registration
    if (pathname === '/mirrors/register' && req.method === 'POST') {
        let body;
        try { body = await parseBody(req); }
        catch { jsonResponse(res, 400, { error: 'Invalid JSON' }); return; }

        if (MIRROR_SECRET && body.secret !== MIRROR_SECRET) {
            jsonResponse(res, 403, { error: 'Invalid secret' });
            return;
        }

        if (!body.url || !isValidMirrorUrl(body.url)) {
            jsonResponse(res, 400, { error: 'Missing or invalid url' });
            return;
        }

        const healthy = await checkMirrorHealth(body.url);
        if (!healthy) {
            jsonResponse(res, 502, { error: 'Mirror health check failed' });
            return;
        }

        mirrors.set(body.url, {
            url: body.url,
            registeredAt: new Date().toISOString(),
            expiresAt: Date.now() + 3600000, // 1 hour
            contributed: false
        });
        saveMirrors();
        jsonResponse(res, 201, { ok: true });
        return;
    }

    // POST /mirrors/contribute — public self-registration
    if (pathname === '/mirrors/contribute' && req.method === 'POST') {
        let body;
        try { body = await parseBody(req); }
        catch { jsonResponse(res, 400, { error: 'Invalid JSON' }); return; }

        if (!body.url || !isValidMirrorUrl(body.url)) {
            jsonResponse(res, 400, { error: 'Missing or invalid url' });
            return;
        }

        const healthy = await checkMirrorHealth(body.url);
        if (!healthy) {
            jsonResponse(res, 502, { error: 'Mirror health check failed' });
            return;
        }

        mirrors.set(body.url, {
            url: body.url,
            registeredAt: new Date().toISOString(),
            expiresAt: Date.now() + 1800000, // 30 minutes
            contributed: true
        });
        saveMirrors();
        jsonResponse(res, 201, { ok: true });
        return;
    }

    // DELETE /mirrors — remove a mirror
    if (pathname === '/mirrors' && req.method === 'DELETE') {
        let body;
        try { body = await parseBody(req); }
        catch { jsonResponse(res, 400, { error: 'Invalid JSON' }); return; }

        if (MIRROR_SECRET && body.secret !== MIRROR_SECRET) {
            jsonResponse(res, 403, { error: 'Invalid secret' });
            return;
        }

        if (body.url) {
            mirrors.delete(body.url);
            saveMirrors();
        }
        jsonResponse(res, 200, { ok: true });
        return;
    }

    jsonResponse(res, 404, { error: 'Not found' });
});

// ── Background: periodically health-check all mirrors (batched) ──
setInterval(async () => {
    const now = Date.now();
    const entries = [...mirrors].filter(([, e]) => e.expiresAt > now);
    const BATCH_SIZE = 5;
    let removed = 0;
    for (let i = 0; i < entries.length; i += BATCH_SIZE) {
        const batch = entries.slice(i, i + BATCH_SIZE);
        const results = await Promise.all(batch.map(async ([url]) => {
            const healthy = await checkMirrorHealth(url);
            return { url, healthy };
        }));
        for (const { url, healthy } of results) {
            if (!healthy) {
                console.log(`[health] Mirror offline: ${url}`);
                mirrors.delete(url);
                removed++;
            }
        }
    }
    if (removed > 0) saveMirrors();
}, 5 * 60 * 1000); // every 5 minutes

// ── Start ───────────────────────────────────────────────
loadMirrors();
server.listen(PORT, () => {
    console.log(`\nRoot mirror registry running on port ${PORT}`);
    console.log(`  Mirrors  → http://localhost:${PORT}/mirrors`);
    console.log(`  Status   → http://localhost:${PORT}/status`);
    console.log(`  Register → POST http://localhost:${PORT}/mirrors/contribute`);
    if (MIRROR_SECRET) console.log(`  Secret   → set`);
    else console.log(`  Secret   → not set (MIRROR_SECRET env var)`);
    console.log();
});

process.on('SIGINT', () => {
    console.log('\nSaving mirrors and shutting down...');
    saveMirrorsSync();
    process.exit(0);
});
