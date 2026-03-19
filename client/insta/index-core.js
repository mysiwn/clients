// ══════════════════════════════════════════════════════════
// Hardened Instagram Client — index-core.js
// ══════════════════════════════════════════════════════════

// ── Constants ────────────────────────────────────────────
const FETCH_TIMEOUT_MS = 10000;
const MEDIA_TIMEOUT_MS = 10000;
const MAX_SEARCH_RESULTS = 15;
const DM_PAGE_SIZE = 20;

// ── Vault (SecureStorage) ────────────────────────────────
const vault = new SecureStorage('instagram');

// ── Helpers ───────────────────────────────────────────────
function escapeHtml(str) { return InputValidator.escapeHtml(str); }
function isValidHttpsUrl(str) { return InputValidator.isValidHttpsUrl(str); }

function showLoadingSkeletons(container, count = 3, type = 'post') {
    container.replaceChildren();
    for (let i = 0; i < count; i++) {
        const skel = document.createElement('div');
        skel.className = 'skeleton-post';
        skel.innerHTML = `<div class="skeleton-header"><div class="skeleton skeleton-avatar"></div><div class="skeleton skeleton-line medium" style="flex:1"></div></div><div class="skeleton skeleton-image"></div><div class="skeleton skeleton-line long"></div>`;
        container.appendChild(skel);
    }
}

function openLightbox(src) {
    const overlay = document.createElement('div');
    overlay.className = 'lightbox-overlay';
    const img = document.createElement('img');
    img.src = src;
    const closeBtn = document.createElement('button');
    closeBtn.className = 'lightbox-close';
    closeBtn.textContent = '\u00D7';
    closeBtn.addEventListener('click', (e) => { e.stopPropagation(); overlay.remove(); });
    overlay.addEventListener('click', () => overlay.remove());
    img.addEventListener('click', (e) => e.stopPropagation());
    overlay.append(img, closeBtn);
    document.body.appendChild(overlay);
    document.addEventListener('keydown', function handler(e) {
        if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', handler); }
    });
}

function placeholderEl(text, isError = false) {
    const div = document.createElement('div');
    div.className = `placeholder${isError ? ' error' : ''}`;
    div.textContent = text;
    return div;
}

function timeAgo(dateStr) {
    const diff = (Date.now() - new Date(dateStr).getTime()) / 1000;
    if (diff < 60) return 'just now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
    if (diff < 604800) return `${Math.floor(diff / 86400)}d`;
    return `${Math.floor(diff / 604800)}w`;
}

// ── Toast Notifications ──────────────────────────────────
function showToast(message, type = 'error', duration = 4000) {
    let container = document.getElementById('toast-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'toast-container';
        container.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:99999;display:flex;flex-direction:column;gap:8px;pointer-events:none;';
        document.body.appendChild(container);
    }
    const toast = document.createElement('div');
    const colors = { success: '#2ed573', error: '#ff4757', info: '#667eea', warning: '#ffa502' };
    toast.style.cssText = `pointer-events:auto;padding:12px 20px;border-radius:8px;color:#fff;font-size:0.88rem;font-family:inherit;background:${colors[type] || colors.info};box-shadow:0 4px 16px rgba(0,0,0,0.3);opacity:0;transform:translateX(40px);transition:opacity 0.25s,transform 0.25s;max-width:360px;word-break:break-word;`;
    toast.textContent = message;
    container.appendChild(toast);
    requestAnimationFrame(() => { toast.style.opacity = '1'; toast.style.transform = 'translateX(0)'; });
    setTimeout(() => {
        toast.style.opacity = '0'; toast.style.transform = 'translateX(40px)';
        setTimeout(() => toast.remove(), 300);
    }, duration);
}

// ── Client Config ─────────────────────────────────────────
const DEFAULT_CONFIG = {
    proxyBase: 'https://cors-proxy.mysiwn.workers.dev',
    notifyMode: 'dm'
};

const VALID_NOTIFY_MODES = ['dm', 'all', 'off'];

async function loadClientConfig() {
    try {
        const raw = await vault.getItem('ig_client_config');
        if (!raw) return null;
        const saved = JSON.parse(raw);
        if (saved && typeof saved === 'object') {
            const cfg = { ...DEFAULT_CONFIG, ...saved };
            if (!isValidHttpsUrl(cfg.proxyBase)) return null;
            if (!VALID_NOTIFY_MODES.includes(cfg.notifyMode)) cfg.notifyMode = 'dm';
            return cfg;
        }
    } catch (e) { console.warn('[instagram]', e); }
    return null;
}

async function saveClientConfig(cfg) {
    await vault.setItem('ig_client_config', JSON.stringify(cfg));
    clientConfig = cfg;
}

let clientConfig = null;

// Instagram API base
const IG_API_BASE = 'https://i.instagram.com/api/v1';
const IG_APP_ID = '936619743392459';

function getApiUrl(endpoint) {
    return clientConfig.proxyBase + '/' + IG_API_BASE + endpoint;
}

// ── State ─────────────────────────────────────────────────
let sessionId       = '';
let csrfToken       = '';
let fullCookies     = '';  // all cookies from Playwright session
let currentUserId   = '';
let currentUsername  = '';
let currentView     = 'feed';
let currentThreadId = null;
let refreshTimeout  = null;
let isConnecting    = false;
let activeBlobUrls  = [];

// ── Settings ──────────────────────────────────────────────
let settings = {
    refreshInterval: 0,
    rootServer: '',       // URL of backup root server (Pi)
    streamTimeout: 60     // seconds of inactivity before disconnect
};

async function loadSettings() {
    try {
        const raw = await vault.getItem('ig_settings');
        if (!raw) return;
        const saved = JSON.parse(raw);
        if (saved && typeof saved === 'object') settings = { ...settings, ...saved };
    } catch (e) { console.warn('[instagram]', e); }
}

async function saveSettings() {
    await vault.setItem('ig_settings', JSON.stringify(settings));
    startAutoRefresh();
}

// ── DOM Refs ──────────────────────────────────────────────
const setupScreen     = document.getElementById('setup-screen');
const loginScreen     = document.getElementById('login-screen');
const appScreen       = document.getElementById('app');
const loginError      = document.getElementById('login-error');
const sidebarContent  = document.getElementById('sidebar-content');
const contentArea     = document.getElementById('content-area');
const headerTitle     = document.getElementById('header-title');
const messageInput    = document.getElementById('message-input');
const sendButton      = document.getElementById('send-button');
const dmInputArea     = document.getElementById('dm-input-area');
const settingsModal   = document.getElementById('settings-modal');
const newDmModal      = document.getElementById('new-dm-modal');
const postModal       = document.getElementById('post-modal');
const connectionStatus  = document.getElementById('connection-status');
const connectionTooltip = document.getElementById('connection-status-tooltip');
const settingRefresh    = document.getElementById('setting-refresh');
const settingProxyUrl   = document.getElementById('setting-proxy-url');
const settingNotifyMode = document.getElementById('setting-notify-mode');

// ── Common Headers ────────────────────────────────────────
function igHeaders() {
    const headers = {
        'X-CSRFToken': csrfToken,
        'X-IG-App-ID': IG_APP_ID,
        'Content-Type': 'application/x-www-form-urlencoded'
    };
    // Use full cookies when available (from Playwright capture), otherwise fallback
    if (fullCookies) {
        headers['X-IG-Full-Cookie'] = fullCookies;
    } else {
        headers['X-IG-Session'] = sessionId;
    }
    headers['X-IG-Csrf'] = csrfToken;
    return headers;
}

// ── Vault PIN Prompt Overlay ─────────────────────────────
function showVaultPinOverlay(mode) {
    return new Promise((resolve, reject) => {
        const overlay = document.createElement('div');
        overlay.id = 'vault-pin-overlay';
        overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.85);display:flex;align-items:center;justify-content:center;z-index:100000;';

        const box = document.createElement('div');
        box.style.cssText = 'background:#1a1a2e;padding:32px;border-radius:16px;min-width:320px;max-width:400px;text-align:center;color:#fff;font-family:inherit;';

        const title = document.createElement('h2');
        title.style.cssText = 'margin:0 0 8px 0;font-size:1.3rem;';
        title.textContent = mode === 'create' ? 'Set Up Vault' : 'Unlock Vault';

        const subtitle = document.createElement('p');
        subtitle.style.cssText = 'margin:0 0 20px 0;color:#aaa;font-size:0.88rem;';
        subtitle.textContent = mode === 'create'
            ? 'Choose a PIN (4+ characters) to encrypt your session data.'
            : 'Enter your PIN to unlock your encrypted session data.';

        const pinInput = document.createElement('input');
        pinInput.type = 'password';
        pinInput.placeholder = 'Enter PIN...';
        pinInput.style.cssText = 'width:100%;padding:12px;border:1px solid #333;border-radius:8px;background:#0d0d1a;color:#fff;font-size:1rem;box-sizing:border-box;margin-bottom:12px;';

        const errorDiv = document.createElement('div');
        errorDiv.style.cssText = 'color:#ff4757;font-size:0.85rem;margin-bottom:12px;min-height:1.2em;';

        const btn = document.createElement('button');
        btn.style.cssText = 'width:100%;padding:12px;border:none;border-radius:8px;background:linear-gradient(135deg,#667eea,#764ba2);color:#fff;font-size:1rem;cursor:pointer;font-family:inherit;';
        btn.textContent = mode === 'create' ? 'Create Vault' : 'Unlock';

        async function submit() {
            const pin = pinInput.value;
            if (!pin) { errorDiv.textContent = 'Please enter a PIN.'; return; }
            if (mode === 'create' && pin.length < 4) { errorDiv.textContent = 'PIN must be at least 4 characters.'; return; }
            btn.disabled = true;
            btn.textContent = 'Please wait...';
            errorDiv.textContent = '';
            try {
                if (mode === 'create') {
                    await vault.create(pin);
                } else {
                    await vault.unlock(pin);
                }
                overlay.remove();
                resolve();
            } catch (err) {
                errorDiv.textContent = err.message;
                btn.disabled = false;
                btn.textContent = mode === 'create' ? 'Create Vault' : 'Unlock';
                pinInput.focus();
            }
        }

        btn.addEventListener('click', submit);
        pinInput.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });

        box.append(title, subtitle, pinInput, errorDiv, btn);
        overlay.appendChild(box);
        document.body.appendChild(overlay);
        pinInput.focus();
    });
}

// ── Setup Screen ──────────────────────────────────────────
document.getElementById('setup-save-btn').addEventListener('click', async () => {
    const proxyBase = document.getElementById('setup-proxy-url').value.trim().replace(/\/+$/, '');
    const notifyMode = document.getElementById('setup-notify-mode').value;
    if (!proxyBase) { showToast('Proxy URL is required.', 'warning'); return; }
    if (!isValidHttpsUrl(proxyBase)) { showToast('Proxy URL must be a valid HTTPS URL.', 'warning'); return; }

    // If vault doesn't exist yet, prompt to create it
    if (!vault.hasVault()) {
        await showVaultPinOverlay('create');
    } else if (vault.isLocked) {
        await showVaultPinOverlay('unlock');
    }

    await saveClientConfig({ proxyBase, notifyMode });
    setupScreen.style.display = 'none';
    showLoginScreen();
});

// ── Init Flow ─────────────────────────────────────────────
let playwrightUrl = localStorage.getItem('ig_playwright_url') || '';

async function init() {
    // If vault exists, unlock it first
    if (vault.hasVault()) {
        if (vault.isLocked) {
            await showVaultPinOverlay('unlock');
        }
        // Now vault is unlocked — load config and sensitive data
        clientConfig = await loadClientConfig();
        await loadSettings();
    } else {
        clientConfig = null;
    }

    if (!clientConfig) { setupScreen.style.display = 'flex'; return; }

    const savedSession = await vault.getItem('ig_session_id');
    if (savedSession) {
        const savedCsrf = await vault.getItem('ig_csrf_token') || '';
        const savedCookies = await vault.getItem('ig_full_cookies') || '';
        await connectWithSession(savedSession, savedCsrf, false, savedCookies);
        return;
    }
    showLoginScreen();
}

function showLoginScreen() {
    document.getElementById('playwright-url-input').value = playwrightUrl;
    loginScreen.style.display = 'flex';
}

// ── Login Tabs (Browser / Session) ───────────────────────
(function () {
    const tabBrowser  = document.getElementById('tab-browser-btn');
    const tabSession  = document.getElementById('tab-session-btn');
    const paneBrowser = document.getElementById('login-tab-playwright');
    const paneSession = document.getElementById('login-tab-session');
    if (!tabBrowser) return;
    function activateTab(which) {
        const isBrowser = which === 'browser';
        tabBrowser.style.borderBottomColor = isBrowser ? 'var(--accent)' : 'transparent';
        tabBrowser.style.color = isBrowser ? 'var(--text-primary)' : 'var(--text-muted)';
        tabSession.style.borderBottomColor = isBrowser ? 'transparent' : 'var(--accent)';
        tabSession.style.color = isBrowser ? 'var(--text-muted)' : 'var(--text-primary)';
        paneBrowser.style.display = isBrowser ? 'block' : 'none';
        paneSession.style.display = isBrowser ? 'none'  : 'block';
    }
    tabBrowser.addEventListener('click', () => activateTab('browser'));
    tabSession.addEventListener('click', () => activateTab('session'));
})();

document.getElementById('session-login-btn').addEventListener('click', async () => {
    const sessionId = document.getElementById('session-input').value.trim();
    if (!sessionId) { showLoginError('Please enter a session ID.'); return; }
    await connectWithSession(sessionId, '', false, '');
});

function showLoginError(msg) {
    loginError.textContent = msg;
    loginError.style.display = msg ? 'block' : 'none';
}

// ── Browser Stream Login ─────────────────────────────────
let browserWs = null;
let browserStreamActive = false;
let pendingReset = false;

async function fetchMirrors() {
    const status = document.getElementById('browser-status');
    status.textContent = 'Fetching mirrors...';
    status.className = 'browser-login-status';
    try {
        // Try proxy first, then root server as fallback
        let mirrorList = [];
        const sources = [clientConfig.proxyBase + '/mirrors'];
        if (settings.rootServer) sources.push(settings.rootServer.replace(/\/+$/, '') + '/mirrors');

        for (const src of sources) {
            try {
                const res = await fetch(src, { signal: AbortSignal.timeout(5000) });
                if (res.ok) {
                    const data = await res.json();
                    if (data.mirrors?.length) { mirrorList = data.mirrors; break; }
                }
            } catch (e) { console.warn('[instagram] mirror source failed:', src, e.message); }
        }

        if (!mirrorList.length) { status.textContent = 'No mirrors listed.'; status.className = 'browser-login-status error'; return; }
        status.textContent = `Testing ${mirrorList.length} mirror(s)...`;
        const available = [];
        await Promise.all(mirrorList.map(async url => {
            try {
                const r = await fetch(url + '/status', { signal: AbortSignal.timeout(3000) });
                if (r.ok) { const d = await r.json(); if (d.ok && (d.instagram?.ready || d.instagram?.hasCachedSession)) available.push(url); }
            } catch (e) { console.warn('[instagram]', e); }
        }));
        if (!available.length) { status.textContent = 'No mirrors online right now.'; status.className = 'browser-login-status error'; return; }
        document.getElementById('playwright-url-input').value = available[0];
        playwrightUrl = available[0];
        localStorage.setItem('ig_playwright_url', playwrightUrl);
        status.textContent = `Found ${available.length} mirror(s). Ready to connect.`;
        status.className = 'browser-login-status success';
    } catch (err) {
        status.textContent = 'Failed to fetch mirrors: ' + err.message;
        status.className = 'browser-login-status error';
    }
}

async function startBrowserLogin() {
    const urlInput = document.getElementById('playwright-url-input');
    const status   = document.getElementById('browser-status');
    const canvas   = document.getElementById('browser-canvas');
    const btn      = document.getElementById('browser-connect-btn');
    const ctx      = canvas.getContext('2d');

    const mirror = urlInput.value.trim().replace(/\/+$/, '');
    if (!mirror) { status.textContent = 'Enter a Playwright server URL first.'; status.className = 'browser-login-status error'; return; }

    playwrightUrl = mirror;
    localStorage.setItem('ig_playwright_url', playwrightUrl);

    btn.disabled = true;
    status.textContent = 'Connecting to ' + new URL(mirror).hostname + '...';
    status.className = 'browser-login-status';
    canvas.style.display = 'block';

    const timeout = settings.streamTimeout ?? 60;
    const wsUrl = mirror.replace(/^http/, 'ws') + '/stream?type=instagram&timeout=' + timeout;
    browserWs = new WebSocket(wsUrl);
    browserStreamActive = true;

    browserWs.onopen = () => {
        if (pendingReset) {
            status.textContent = 'Requesting fresh login...';
            browserWs.send(JSON.stringify({ type: 'reset' }));
            pendingReset = false;
        } else {
            status.textContent = 'Connected — log in below';
        }
        status.className = 'browser-login-status success';
    };

    browserWs.onmessage = (evt) => {
        let msg;
        try { msg = JSON.parse(evt.data); } catch (e) { console.warn('[instagram]', e); return; }

        if (msg.type === 'screenshot') {
            const img = new Image();
            img.onload = () => {
                if (canvas.width !== msg.width || canvas.height !== msg.height) {
                    canvas.width = msg.width;
                    canvas.height = msg.height;
                }
                ctx.drawImage(img, 0, 0);
            };
            img.src = 'data:image/jpeg;base64,' + msg.data;
        } else if (msg.type === 'session') {
            status.textContent = 'Login successful! Connecting...';
            status.className = 'browser-login-status success';
            cleanupBrowserStream();
            connectWithSession(msg.sessionId, msg.csrfToken || '', true, msg.fullCookies || '');
        } else if (msg.type === 'tabs') {
            renderTabBar(msg.tabs, sendInput);
        } else if (msg.type === 'timeout') {
            status.textContent = msg.message;
            status.className = 'browser-login-status error';
            cleanupBrowserStream();
            btn.disabled = false;
            canvas.style.display = 'none';
        } else if (msg.type === 'status') {
            status.textContent = msg.text;
        } else if (msg.type === 'error') {
            status.textContent = msg.message;
            status.className = 'browser-login-status error';
        }
    };

    browserWs.onclose = () => {
        if (browserStreamActive) {
            status.textContent = 'Disconnected from server.';
            status.className = 'browser-login-status error';
            cleanupBrowserStream();
            btn.disabled = false;
            canvas.style.display = 'none';
        }
    };

    browserWs.onerror = (err) => {
        console.warn('[instagram] WebSocket error:', err);
    };

    // Forward mouse events from canvas → server
    function sendInput(msg) {
        if (browserWs && browserWs.readyState === WebSocket.OPEN) {
            browserWs.send(JSON.stringify(msg));
        }
    }

    function canvasCoords(e) {
        const rect = canvas.getBoundingClientRect();
        return {
            x: (e.clientX - rect.left) / rect.width,
            y: (e.clientY - rect.top) / rect.height
        };
    }

    canvas.onmousemove = (e) => {
        const c = canvasCoords(e);
        sendInput({ type: 'mousemove', x: c.x, y: c.y });
    };
    canvas.onclick = (e) => {
        const c = canvasCoords(e);
        sendInput({ type: 'click', x: c.x, y: c.y, button: 'left' });
    };
    canvas.ondblclick = (e) => {
        const c = canvasCoords(e);
        sendInput({ type: 'dblclick', x: c.x, y: c.y });
    };
    canvas.oncontextmenu = (e) => {
        e.preventDefault();
        const c = canvasCoords(e);
        sendInput({ type: 'click', x: c.x, y: c.y, button: 'right' });
    };
    canvas.onwheel = (e) => {
        e.preventDefault();
        const c = canvasCoords(e);
        sendInput({ type: 'scroll', x: c.x, y: c.y, deltaX: e.deltaX, deltaY: e.deltaY });
    };

    // Forward keyboard events when canvas is focused
    canvas.tabIndex = 0;
    canvas.focus();
    canvas.onkeydown = (e) => {
        e.preventDefault();
        sendInput({ type: 'keydown', key: e.key });
    };
    canvas.onkeyup = (e) => {
        e.preventDefault();
        sendInput({ type: 'keyup', key: e.key });
    };
}

function renderTabBar(tabs, sendInput) {
    let bar = document.getElementById('browser-tab-bar');
    if (!bar) {
        bar = document.createElement('div');
        bar.id = 'browser-tab-bar';
        bar.style.cssText = 'display:flex;gap:2px;padding:4px 0;overflow-x:auto;align-items:center;';
        const canvas = document.getElementById('browser-canvas');
        canvas.parentNode.insertBefore(bar, canvas);
    }
    bar.replaceChildren();
    tabs.forEach(tab => {
        const btn = document.createElement('button');
        btn.textContent = tab.title || 'Tab';
        btn.style.cssText = `padding:4px 12px;border:none;border-radius:4px 4px 0 0;font-size:0.78rem;cursor:pointer;max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:inherit;${tab.active ? 'background:#333;color:#fff;' : 'background:#1a1a1a;color:#888;'}`;
        btn.addEventListener('click', () => sendInput({ type: 'switchtab', index: tab.index }));
        bar.appendChild(btn);
    });
    // New tab button
    const addBtn = document.createElement('button');
    addBtn.textContent = '+';
    addBtn.title = 'New tab';
    addBtn.style.cssText = 'padding:4px 10px;border:none;border-radius:4px;background:#222;color:#888;cursor:pointer;font-size:0.85rem;font-family:inherit;';
    addBtn.addEventListener('click', () => sendInput({ type: 'newtab' }));
    bar.appendChild(addBtn);
}

function cleanupBrowserStream() {
    browserStreamActive = false;
    if (browserWs) {
        try { browserWs.close(); } catch (e) { console.warn('[instagram]', e); }
        browserWs = null;
    }
    const btn = document.getElementById('browser-connect-btn');
    if (btn) btn.disabled = false;
    const canvas = document.getElementById('browser-canvas');
    if (canvas) canvas.style.display = 'none';
    const bar = document.getElementById('browser-tab-bar');
    if (bar) bar.remove();
}

document.getElementById('playwright-url-input').addEventListener('input', e => {
    playwrightUrl = e.target.value.trim();
});
document.getElementById('browser-connect-btn').addEventListener('click', startBrowserLogin);
document.getElementById('browser-find-btn').addEventListener('click', fetchMirrors);

// ── Session Connect ───────────────────────────────────────
async function connectWithSession(sid, csrf, fromServer = false, cookies = '') {
    if (isConnecting) return;
    isConnecting = true;
    sessionId = sid.trim();
    fullCookies = cookies || '';

    // CSRF token validation — reject empty tokens
    const trimmedCsrf = csrf.trim();
    if (!trimmedCsrf) {
        showLoginError('CSRF token is missing or empty. Please log in again.');
        isConnecting = false;
        showLoginScreen();
        return;
    }
    csrfToken = trimmedCsrf;

    showLoginError('');
    try {
        let res;
        try {
            res = await fetch(getApiUrl('/accounts/current_user/?edit=true'), {
                headers: igHeaders(),
                mode: 'cors',
                signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
            });
        } catch (err) {
            throw new Error('Connection failed. Make sure your proxy URL is correct and you have internet access.');
        }
        if (res.status === 401 || res.status === 403) throw new Error('Invalid or expired session.');
        if (!res.ok) throw new Error(`Server responded with ${res.status}.`);
        const data = await res.json();
        const user = data.user;
        if (!user || !user.pk) throw new Error('Could not retrieve user info.');
        currentUserId = String(user.pk);
        currentUsername = user.username;
        await vault.setItem('ig_session_id', sessionId);
        await vault.setItem('ig_csrf_token', csrfToken);
        if (fullCookies) await vault.setItem('ig_full_cookies', fullCookies);
        loginScreen.style.display = 'none';
        appScreen.style.display = 'flex';
        if (clientConfig.notifyMode !== 'off' && 'Notification' in window && Notification.permission === 'default') Notification.requestPermission();
        setConnectionStatus('polling', 'Polling');
        loadFeed();
        startAutoRefresh();
    } catch (err) {
        vault.removeItem('ig_session_id');
        vault.removeItem('ig_csrf_token');
        vault.removeItem('ig_full_cookies');
        fullCookies = '';
        if (fromServer && playwrightUrl) {
            // Cached session from server was stale — auto-reset and re-login
            pendingReset = true;
            showLoginError('Session expired — reconnecting for fresh login...');
            showLoginScreen();
            startBrowserLogin();
        } else {
            showLoginError(`Connection failed: ${err.message}`);
            showLoginScreen();
        }
    } finally {
        isConnecting = false;
    }
}

// ── Connection Status ─────────────────────────────────────
function setConnectionStatus(status, tooltip) {
    connectionStatus.className = 'connection-status ' + status;
    connectionTooltip.textContent = tooltip;
}

// ── Auto Refresh ──────────────────────────────────────────
function startAutoRefresh() {
    clearTimeout(refreshTimeout);
    if (settings.refreshInterval >= 30 && sessionId) {
        refreshTimeout = setTimeout(() => {
            if (currentView === 'feed') loadFeed(true);
            else if (currentView === 'inbox' && currentThreadId) loadThread(currentThreadId, true);
            else if (currentView === 'inbox') loadInbox(true);
            startAutoRefresh();
        }, settings.refreshInterval * 1000);
    }
}

// ── API Call ──────────────────────────────────────────────
async function igApi(endpoint, options = {}) {
    const headers = { ...igHeaders(), ...options.headers };
    if (options.json) {
        headers['Content-Type'] = 'application/json';
        options.body = JSON.stringify(options.json);
        delete options.json;
    }
    let res;
    try {
        res = await fetch(getApiUrl(endpoint), { ...options, headers, mode: 'cors', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    } catch (err) {
        throw new Error('Connection failed. Check your proxy URL and network connection.');
    }

    // Retry once on transient failures (429 / 503)
    if (res.status === 429 || res.status === 503) {
        const retryAfter = parseInt(res.headers.get('Retry-After') || '2');
        await new Promise(r => setTimeout(r, retryAfter * 1000));
        res = await fetch(getApiUrl(endpoint), { ...options, headers, mode: 'cors', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    }

    if (!res.ok) throw new Error(`API ${res.status}`);
    return res.json();
}

// ── Proxy Media ───────────────────────────────────────────
async function proxyMedia(url) {
    // Validate media URL before proxying
    if (!InputValidator.isAllowedMediaUrl(url)) {
        throw new Error('Media URL not allowed: ' + url);
    }
    let res;
    try {
        res = await fetch(`${clientConfig.proxyBase}/image`, { headers: { 'mediaurl': url }, mode: 'cors', signal: AbortSignal.timeout(MEDIA_TIMEOUT_MS) });
    } catch (err) {
        throw new Error('Image load failed. Check your proxy URL and network connection.');
    }
    if (!res.ok) throw new Error(res.status);
    const blob = await res.blob(), blobUrl = URL.createObjectURL(blob);
    return blobUrl;
}

function clearBlobUrls() {
    activeBlobUrls.forEach(u => URL.revokeObjectURL(u));
    activeBlobUrls = [];
}

function loadProxiedImage(imgEl, url) {
    if (!url) return;

    // Validate media URL — skip proxy for disallowed URLs
    if (!InputValidator.isAllowedMediaUrl(url)) {
        imgEl.src = url;
        return;
    }

    imgEl.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
    proxyMedia(url).then(blobUrl => {
        activeBlobUrls.push(blobUrl);
        imgEl.src = blobUrl;
        imgEl.onload = () => { /* loaded successfully */ };
        imgEl.onerror = () => {
            const idx = activeBlobUrls.indexOf(blobUrl);
            if (idx > -1) { URL.revokeObjectURL(activeBlobUrls[idx]); activeBlobUrls.splice(idx, 1); }
            imgEl.src = url; // fallback to direct URL
        };
    }).catch(() => {
        imgEl.src = url;
    });
}

// ── Nav Tabs ──────────────────────────────────────────────
document.querySelectorAll('.nav-tab').forEach(tab => {
    tab.addEventListener('click', () => {
        document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        currentView = tab.dataset.view;
        currentThreadId = null;
        dmInputArea.style.display = 'none';
        switch (currentView) {
            case 'feed': headerTitle.textContent = 'Feed'; loadFeed(); break;
            case 'inbox': headerTitle.textContent = 'Inbox'; loadInbox(); break;
            case 'explore': headerTitle.textContent = 'Explore'; loadExplore(); break;
            case 'profile': headerTitle.textContent = 'Profile'; loadProfile(); break;
        }
    });
});
