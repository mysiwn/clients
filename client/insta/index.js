// ══════════════════════════════════════════════════════════
// Hardened Instagram Client — index.js
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

// ══════════════════════════════════════════════════════════
// FEED
// ══════════════════════════════════════════════════════════

async function loadFeed(silent = false) {
    if (!silent) {
        clearBlobUrls();
        contentArea.replaceChildren();
        sidebarContent.replaceChildren();
        showLoadingSkeletons(contentArea, 3);
    }
    try {
        const [feedData, storiesData] = await Promise.all([
            igApi('/feed/timeline/', {
                method: 'POST',
                body: new URLSearchParams({ is_prefetch: '0', feed_view_info: '', seen_posts: '', phone_id: crypto.randomUUID(), battery_level: '100', is_charging: '1', will_sound_on: '0', is_on_screen: 'true', timezone_offset: String(-new Date().getTimezoneOffset() * 60), is_async_ads_in_headload_enabled: '0', is_async_ads_double_request: '0', is_async_ads_rti: '0' }).toString(),
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
            }),
            igApi('/feed/reels_tray/').catch(() => ({ tray: [] }))
        ]);

        if (!silent) {
            clearBlobUrls();
            contentArea.replaceChildren();
        }

        // Stories row
        if (storiesData.tray && storiesData.tray.length > 0 && !silent) {
            const storiesRow = document.createElement('div');
            storiesRow.className = 'stories-row';
            storiesData.tray.slice(0, 20).forEach(story => {
                const user = story.user;
                if (!user) return;
                const item = document.createElement('div');
                item.className = 'story-item';
                const ring = document.createElement('div');
                ring.className = 'story-ring' + (story.seen ? ' seen' : '');
                const img = document.createElement('img');
                loadProxiedImage(img, user.profile_pic_url);
                ring.appendChild(img);
                const name = document.createElement('div');
                name.className = 'story-name';
                name.textContent = user.username;
                item.append(ring, name);
                storiesRow.appendChild(item);
            });
            contentArea.appendChild(storiesRow);
        }

        // Feed posts
        const items = feedData.feed_items || feedData.items || [];
        if (items.length === 0 && !silent) {
            contentArea.appendChild(placeholderEl('No posts in your feed.'));
            return;
        }

        items.forEach(item => {
            const media = item.media_or_ad || item;
            if (!media || !media.user) return;
            const post = buildFeedPost(media);
            if (post) contentArea.appendChild(post);
        });
    } catch (err) {
        if (!silent) {
            clearBlobUrls();
            contentArea.replaceChildren();
            contentArea.appendChild(placeholderEl(`Failed to load feed: ${err.message}`, true));
        }
    }
}

function buildFeedPost(media) {
    const post = document.createElement('div');
    post.className = 'feed-post';

    // Header
    const header = document.createElement('div');
    header.className = 'post-header';
    const avatar = document.createElement('img');
    avatar.className = 'post-avatar';
    loadProxiedImage(avatar, media.user.profile_pic_url);
    const username = document.createElement('span');
    username.className = 'post-username';
    username.textContent = media.user.username;
    header.append(avatar, username);
    post.appendChild(header);

    // Image/Video
    const container = document.createElement('div');
    container.className = 'post-image-container';

    if (media.carousel_media && media.carousel_media.length > 0) {
        const firstMedia = media.carousel_media[0];
        appendMediaElement(container, firstMedia);
    } else if (media.video_versions && media.video_versions.length > 0) {
        const video = document.createElement('video');
        video.className = 'post-video';
        video.controls = true;
        video.preload = 'metadata';
        const videoUrl = media.video_versions[0].url;
        if (InputValidator.isAllowedMediaUrl(videoUrl)) {
            proxyMedia(videoUrl).then(blobUrl => { activeBlobUrls.push(blobUrl); video.src = blobUrl; }).catch(() => { video.src = videoUrl; });
        } else {
            video.src = videoUrl;
        }
        container.appendChild(video);
    } else if (media.image_versions2 && media.image_versions2.candidates && media.image_versions2.candidates.length > 0) {
        const img = document.createElement('img');
        img.className = 'post-image';
        loadProxiedImage(img, media.image_versions2.candidates[0].url);
        container.appendChild(img);
    }

    post.appendChild(container);

    // Actions
    const actions = document.createElement('div');
    actions.className = 'post-actions';
    const likeBtn = document.createElement('button');
    likeBtn.className = 'post-action-btn' + (media.has_liked ? ' liked' : '');
    likeBtn.textContent = media.has_liked ? '\u2764\uFE0F' : '\u2661';
    likeBtn.addEventListener('click', async () => {
        try {
            const endpoint = media.has_liked
                ? `/media/${media.id}/unlike/`
                : `/media/${media.id}/like/`;
            await igApi(endpoint, { method: 'POST', body: new URLSearchParams({ media_id: media.id }).toString(), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
            media.has_liked = !media.has_liked;
            likeBtn.className = 'post-action-btn' + (media.has_liked ? ' liked' : '');
            likeBtn.textContent = media.has_liked ? '\u2764\uFE0F' : '\u2661';
            const likesEl = post.querySelector('.post-likes');
            if (likesEl) {
                const count = media.like_count + (media.has_liked ? 1 : -1);
                media.like_count = count;
                likesEl.textContent = `${count.toLocaleString()} like${count !== 1 ? 's' : ''}`;
            }
        } catch (e) {
            console.warn('[instagram]', e);
            showToast('Failed to update like.', 'error');
        }
    });
    actions.appendChild(likeBtn);
    post.appendChild(actions);

    // Likes
    if (media.like_count != null) {
        const likes = document.createElement('div');
        likes.className = 'post-likes';
        likes.textContent = `${media.like_count.toLocaleString()} like${media.like_count !== 1 ? 's' : ''}`;
        post.appendChild(likes);
    }

    // Caption
    if (media.caption && media.caption.text) {
        const caption = document.createElement('div');
        caption.className = 'post-caption';
        const capUser = document.createElement('span');
        capUser.className = 'caption-username';
        capUser.textContent = media.user.username;
        const capText = document.createTextNode(media.caption.text);
        caption.append(capUser, capText);
        post.appendChild(caption);
    }

    // Timestamp
    if (media.taken_at) {
        const ts = document.createElement('div');
        ts.className = 'post-timestamp';
        ts.textContent = timeAgo(new Date(media.taken_at * 1000).toISOString());
        post.appendChild(ts);
    }

    return post;
}

function appendMediaElement(container, media) {
    if (media.video_versions && media.video_versions.length > 0) {
        const video = document.createElement('video');
        video.className = 'post-video';
        video.controls = true;
        video.preload = 'metadata';
        const url = media.video_versions[0].url;
        if (InputValidator.isAllowedMediaUrl(url)) {
            proxyMedia(url).then(blobUrl => { activeBlobUrls.push(blobUrl); video.src = blobUrl; }).catch(() => { video.src = url; });
        } else {
            video.src = url;
        }
        container.appendChild(video);
    } else if (media.image_versions2 && media.image_versions2.candidates && media.image_versions2.candidates.length > 0) {
        const img = document.createElement('img');
        img.className = 'post-image';
        loadProxiedImage(img, media.image_versions2.candidates[0].url);
        container.appendChild(img);
    }
}

// ══════════════════════════════════════════════════════════
// INBOX (DMs)
// ══════════════════════════════════════════════════════════

async function loadInbox(silent = false) {
    if (!silent) {
        sidebarContent.replaceChildren();
        contentArea.replaceChildren();
        dmInputArea.style.display = 'none';
        showLoadingSkeletons(sidebarContent, 5);
    }
    try {
        const data = await igApi(`/direct_v2/inbox/?visual_message_return_type=unseen&persistentBadging=true&limit=${DM_PAGE_SIZE}`);
        const inbox = data.inbox;
        if (!inbox || !inbox.threads) throw new Error('No inbox data');

        sidebarContent.replaceChildren();

        // Add "New Message" label
        const label = document.createElement('div');
        label.className = 'sidebar-label';
        label.textContent = 'Messages';
        const addBtn = document.createElement('span');
        addBtn.className = 'sidebar-label-add';
        addBtn.textContent = '+';
        addBtn.title = 'New Message';
        addBtn.addEventListener('click', openNewDmModal);
        label.appendChild(addBtn);
        sidebarContent.appendChild(label);

        inbox.threads.forEach(thread => {
            const item = buildThreadItem(thread);
            sidebarContent.appendChild(item);
        });

        if (!silent && !currentThreadId) {
            contentArea.replaceChildren();
            contentArea.appendChild(placeholderEl('Select a conversation'));
        }
    } catch (err) {
        if (!silent) {
            sidebarContent.replaceChildren();
            sidebarContent.appendChild(placeholderEl(`Failed to load inbox: ${err.message}`, true));
        }
    }
}

function buildThreadItem(thread) {
    const item = document.createElement('div');
    item.className = 'thread-item' + (thread.read_state === 0 ? ' unread' : '');
    if (currentThreadId === thread.thread_id) item.classList.add('active');

    const avatar = document.createElement('img');
    avatar.className = 'thread-avatar';
    const users = thread.users || [];
    if (users.length > 0 && users[0].profile_pic_url) {
        loadProxiedImage(avatar, users[0].profile_pic_url);
    }

    const info = document.createElement('div');
    info.className = 'thread-info';
    const name = document.createElement('div');
    name.className = 'thread-name';
    name.textContent = thread.thread_title || users.map(u => u.username).join(', ') || 'Unknown';
    const preview = document.createElement('div');
    preview.className = 'thread-preview';
    const lastItem = thread.last_permanent_item || (thread.items && thread.items[0]);
    if (lastItem) {
        if (lastItem.item_type === 'text') preview.textContent = lastItem.text || '';
        else if (lastItem.item_type === 'media_share') preview.textContent = 'Shared a post';
        else if (lastItem.item_type === 'raven_media') preview.textContent = 'Sent a photo';
        else if (lastItem.item_type === 'link') preview.textContent = 'Shared a link';
        else preview.textContent = lastItem.item_type || '';
    }

    info.append(name, preview);
    item.append(avatar, info);

    item.addEventListener('click', () => {
        document.querySelectorAll('.thread-item').forEach(t => t.classList.remove('active'));
        item.classList.add('active');
        item.classList.remove('unread');
        const title = name.textContent;
        headerTitle.textContent = title;
        loadThread(thread.thread_id);
    });

    return item;
}

async function loadThread(threadId, silent = false) {
    currentThreadId = threadId;
    dmInputArea.style.display = 'flex';
    messageInput.disabled = false;
    sendButton.disabled = false;

    if (!silent) {
        contentArea.replaceChildren();
        showLoadingSkeletons(contentArea, 5);
    }

    try {
        const data = await igApi(`/direct_v2/threads/${threadId}/?visual_message_return_type=unseen&limit=30`);
        if (currentThreadId !== threadId) return; // stale response, user navigated away
        const thread = data.thread;
        if (!thread) throw new Error('No thread data');

        contentArea.replaceChildren();
        const msgContainer = document.createElement('div');
        msgContainer.className = 'dm-messages';

        const items = (thread.items || []).slice().reverse();
        items.forEach(item => {
            const bubble = buildDmBubble(item, thread);
            if (bubble) msgContainer.appendChild(bubble);
        });

        contentArea.appendChild(msgContainer);
        contentArea.scrollTop = contentArea.scrollHeight;
    } catch (err) {
        if (!silent) {
            contentArea.replaceChildren();
            contentArea.appendChild(placeholderEl(`Failed to load messages: ${err.message}`, true));
        }
    }
}

function buildDmBubble(item, thread) {
    const bubble = document.createElement('div');
    const isSent = String(item.user_id) === currentUserId;
    bubble.className = 'dm-bubble ' + (isSent ? 'sent' : 'received');

    // Sender name for group chats
    if (!isSent && thread.users && thread.users.length > 1) {
        const sender = thread.users.find(u => String(u.pk) === String(item.user_id));
        if (sender) {
            const senderSpan = document.createElement('span');
            senderSpan.className = 'bubble-sender';
            senderSpan.textContent = sender.username;
            bubble.appendChild(senderSpan);
        }
    }

    // Content
    if (item.item_type === 'text' && item.text) {
        const text = document.createTextNode(item.text);
        bubble.appendChild(text);
    } else if (item.item_type === 'media' || item.item_type === 'raven_media') {
        const media = item.media || item.visual_media?.media;
        if (media) {
            if (media.image_versions2 && media.image_versions2.candidates && media.image_versions2.candidates.length > 0) {
                const img = document.createElement('img');
                img.className = 'dm-media';
                loadProxiedImage(img, media.image_versions2.candidates[0].url);
                bubble.appendChild(img);
            } else if (media.video_versions && media.video_versions.length > 0) {
                const video = document.createElement('video');
                video.className = 'dm-media';
                video.controls = true;
                const url = media.video_versions[0].url;
                if (InputValidator.isAllowedMediaUrl(url)) {
                    proxyMedia(url).then(blobUrl => { activeBlobUrls.push(blobUrl); video.src = blobUrl; }).catch(() => { video.src = url; });
                } else {
                    video.src = url;
                }
                bubble.appendChild(video);
            }
        } else {
            const text = document.createTextNode('[Media]');
            bubble.appendChild(text);
        }
    } else if (item.item_type === 'media_share') {
        const text = document.createTextNode('[Shared a post]');
        bubble.appendChild(text);
    } else if (item.item_type === 'link' && item.link) {
        const a = document.createElement('a');
        a.href = item.link.text || '#';
        a.target = '_blank';
        a.rel = 'noopener';
        a.textContent = item.link.text || '[Link]';
        a.style.color = isSent ? '#fff' : '#0095f6';
        bubble.appendChild(a);
    } else if (item.item_type === 'like') {
        const text = document.createTextNode(item.like || '\u2764\uFE0F');
        bubble.appendChild(text);
    } else if (item.item_type === 'animated_media') {
        const text = document.createTextNode('[GIF]');
        bubble.appendChild(text);
    } else if (item.item_type === 'voice_media') {
        const text = document.createTextNode('[Voice message]');
        bubble.appendChild(text);
    } else {
        const text = document.createTextNode(`[${item.item_type || 'Unknown'}]`);
        bubble.appendChild(text);
    }

    // Timestamp
    if (item.timestamp) {
        const time = document.createElement('span');
        time.className = 'bubble-time';
        time.textContent = timeAgo(new Date(item.timestamp / 1000).toISOString());
        bubble.appendChild(time);
    }

    return bubble;
}

// ── Send DM ───────────────────────────────────────────────
sendButton.addEventListener('click', sendDm);
messageInput.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendDm(); } });

async function sendDm() {
    const text = messageInput.value.trim();
    if (!text || !currentThreadId) return;
    messageInput.disabled = true;
    sendButton.disabled = true;
    try {
        const body = new URLSearchParams({
            action: 'send_item',
            thread_ids: `[${currentThreadId}]`,
            client_context: crypto.randomUUID(),
            text
        });
        await igApi('/direct_v2/threads/broadcast/text/', {
            method: 'POST',
            body: body.toString(),
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });
        messageInput.value = '';
        loadThread(currentThreadId);
    } catch (err) {
        showToast(`Failed to send: ${err.message}`);
        messageInput.focus();
    } finally {
        messageInput.disabled = false;
        sendButton.disabled = false;
    }
}

// ── New DM Modal ──────────────────────────────────────────
const newDmSearch   = document.getElementById('new-dm-search');
const newDmResults  = document.getElementById('new-dm-results');
let searchTimeout   = null;

function openNewDmModal() {
    newDmSearch.value = '';
    newDmResults.replaceChildren();
    newDmModal.style.display = 'flex';
    newDmSearch.focus();
}

function closeNewDmModal() {
    clearTimeout(searchTimeout);
    newDmModal.style.display = 'none';
}

document.getElementById('new-dm-cancel-btn').addEventListener('click', closeNewDmModal);

newDmSearch.addEventListener('input', () => {
    clearTimeout(searchTimeout);
    const query = newDmSearch.value.trim();
    if (!query) { newDmResults.replaceChildren(); return; }
    searchTimeout = setTimeout(() => searchUsers(query), 400);
});

async function searchUsers(query) {
    try {
        const data = await igApi(`/users/search/?q=${encodeURIComponent(query)}&count=10`);
        newDmResults.replaceChildren();
        (data.users || []).forEach(user => {
            const item = document.createElement('div');
            item.className = 'search-result-item';
            const img = document.createElement('img');
            loadProxiedImage(img, user.profile_pic_url);
            const info = document.createElement('div');
            const nameLine = document.createElement('div');
            nameLine.className = 'result-name';
            nameLine.textContent = user.username;
            const fullLine = document.createElement('div');
            fullLine.className = 'result-fullname';
            fullLine.textContent = user.full_name || '';
            info.append(nameLine, fullLine);
            item.append(img, info);
            item.addEventListener('click', async () => {
                try {
                    const res = await igApi('/direct_v2/create_group_thread/', {
                        method: 'POST',
                        body: new URLSearchParams({ recipient_users: `[${user.pk}]` }).toString(),
                        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
                    });
                    closeNewDmModal();
                    currentView = 'inbox';
                    document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
                    document.querySelector('.nav-tab[data-view="inbox"]').classList.add('active');
                    headerTitle.textContent = user.username;
                    await loadInbox();
                    if (res.thread_id) loadThread(res.thread_id);
                } catch (err) {
                    showToast(`Failed to create DM: ${err.message}`);
                }
            });
            newDmResults.appendChild(item);
        });
    } catch (e) {
        console.warn('[instagram]', e);
        showToast('Search failed. Please try again.', 'error');
    }
}

// ══════════════════════════════════════════════════════════
// EXPLORE
// ══════════════════════════════════════════════════════════

async function loadExplore() {
    clearBlobUrls();
    contentArea.replaceChildren();
    sidebarContent.replaceChildren();
    showLoadingSkeletons(contentArea, 4);

    // Sidebar: search
    const searchLabel = document.createElement('div');
    searchLabel.className = 'sidebar-label';
    searchLabel.textContent = 'Search';
    sidebarContent.appendChild(searchLabel);
    const searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.className = 'login-input';
    searchInput.placeholder = 'Search users...';
    searchInput.style.marginBottom = '8px';
    sidebarContent.appendChild(searchInput);
    const searchResultsDiv = document.createElement('div');
    sidebarContent.appendChild(searchResultsDiv);

    searchInput.addEventListener('input', () => {
        clearTimeout(searchTimeout);
        const q = searchInput.value.trim();
        if (!q) { searchResultsDiv.replaceChildren(); return; }
        searchTimeout = setTimeout(async () => {
            try {
                const data = await igApi(`/users/search/?q=${encodeURIComponent(q)}&count=${MAX_SEARCH_RESULTS}`);
                searchResultsDiv.replaceChildren();
                (data.users || []).forEach(user => {
                    const item = document.createElement('div');
                    item.className = 'search-result-item';
                    const img = document.createElement('img');
                    loadProxiedImage(img, user.profile_pic_url);
                    const info = document.createElement('div');
                    const nameLine = document.createElement('div');
                    nameLine.className = 'result-name';
                    nameLine.textContent = user.username;
                    const fullLine = document.createElement('div');
                    fullLine.className = 'result-fullname';
                    fullLine.textContent = user.full_name || '';
                    info.append(nameLine, fullLine);
                    item.append(img, info);
                    item.addEventListener('click', () => loadUserProfile(user.pk, user.username));
                    searchResultsDiv.appendChild(item);
                });
            } catch (e) {
                console.warn('[instagram]', e);
                showToast('Search failed. Please try again.', 'error');
            }
        }, 400);
    });

    try {
        const data = await igApi('/discover/topical_explore/?is_prefetch=false&omit_cover_media=false&use_sectional_payload=true&timezone_offset=0&session_id=' + crypto.randomUUID() + '&include_fixed_destinations=false');
        contentArea.replaceChildren();

        const grid = document.createElement('div');
        grid.className = 'explore-grid';

        const sectional = data.sectional_items || [];
        const mediaItems = [];
        sectional.forEach(section => {
            if (section.layout_content && section.layout_content.medias) {
                section.layout_content.medias.forEach(m => {
                    if (m.media) mediaItems.push(m.media);
                });
            }
            if (section.layout_content && section.layout_content.one_by_two_item) {
                const obt = section.layout_content.one_by_two_item;
                if (obt.media) mediaItems.push(obt.media);
            }
            if (section.layout_content && section.layout_content.two_by_two_item) {
                if (section.layout_content.two_by_two_item.media) mediaItems.push(section.layout_content.two_by_two_item.media);
            }
        });

        // Also try flat items
        if (data.items) {
            data.items.forEach(item => {
                if (item.media) mediaItems.push(item.media);
            });
        }

        if (mediaItems.length === 0) {
            contentArea.appendChild(placeholderEl('No explore content available.'));
            return;
        }

        mediaItems.forEach(media => {
            const item = document.createElement('div');
            item.className = 'explore-item';
            const img = document.createElement('img');
            if (media.image_versions2 && media.image_versions2.candidates && media.image_versions2.candidates.length > 0) {
                loadProxiedImage(img, media.image_versions2.candidates[0].url);
            }
            item.appendChild(img);
            item.addEventListener('click', () => {
                showPostModal(media);
            });
            grid.appendChild(item);
        });

        contentArea.appendChild(grid);
    } catch (err) {
        contentArea.replaceChildren();
        contentArea.appendChild(placeholderEl(`Failed to load explore: ${err.message}`, true));
    }
}

function showPostModal(media) {
    const viewer = document.getElementById('post-viewer-content');
    viewer.replaceChildren();
    const post = buildFeedPost(media);
    if (post) viewer.appendChild(post);
    postModal.style.display = 'flex';
}

document.getElementById('post-modal-close').addEventListener('click', () => {
    postModal.style.display = 'none';
});

// ══════════════════════════════════════════════════════════
// PROFILE
// ══════════════════════════════════════════════════════════

async function loadProfile() {
    loadUserProfile(currentUserId, currentUsername);
}

async function loadUserProfile(userId, username) {
    clearBlobUrls();
    contentArea.replaceChildren();
    sidebarContent.replaceChildren();
    showLoadingSkeletons(contentArea, 3);

    try {
        const [userData, feedData] = await Promise.all([
            igApi(`/users/${userId}/info/`),
            igApi(`/feed/user/${userId}/?count=18`).catch(() => ({ items: [] }))
        ]);

        const user = userData.user;
        if (!user) throw new Error('No user data');

        contentArea.replaceChildren();

        // Profile header
        const header = document.createElement('div');
        header.className = 'profile-header';
        const pic = document.createElement('img');
        pic.className = 'profile-pic';
        loadProxiedImage(pic, user.profile_pic_url || user.hd_profile_pic_url_info?.url);
        const info = document.createElement('div');
        info.className = 'profile-info';
        const uname = document.createElement('div');
        uname.className = 'profile-username';
        uname.textContent = user.username;
        const stats = document.createElement('div');
        stats.className = 'profile-stats';
        function statSpan(count, label) {
            const span = document.createElement('span');
            const strong = document.createElement('strong');
            strong.textContent = (count || 0).toLocaleString();
            span.append(strong, ' ' + label);
            return span;
        }
        stats.append(statSpan(user.media_count, 'posts'), statSpan(user.follower_count, 'followers'), statSpan(user.following_count, 'following'));

        info.appendChild(uname);
        info.appendChild(stats);

        if (user.biography) {
            const bio = document.createElement('div');
            bio.className = 'profile-bio';
            bio.textContent = user.biography;
            info.appendChild(bio);
        }

        header.append(pic, info);
        contentArea.appendChild(header);

        // Post grid
        const items = feedData.items || [];
        if (items.length === 0) {
            contentArea.appendChild(placeholderEl('No posts yet.'));
            return;
        }

        const grid = document.createElement('div');
        grid.className = 'profile-grid';

        items.forEach(item => {
            const gridItem = document.createElement('div');
            gridItem.className = 'profile-grid-item';
            const img = document.createElement('img');
            if (item.image_versions2 && item.image_versions2.candidates && item.image_versions2.candidates.length > 0) {
                loadProxiedImage(img, item.image_versions2.candidates[0].url);
            } else if (item.carousel_media && item.carousel_media[0]?.image_versions2?.candidates) {
                loadProxiedImage(img, item.carousel_media[0].image_versions2.candidates[0].url);
            }
            gridItem.appendChild(img);
            gridItem.addEventListener('click', () => showPostModal(item));
            grid.appendChild(gridItem);
        });

        contentArea.appendChild(grid);
    } catch (err) {
        contentArea.replaceChildren();
        contentArea.appendChild(placeholderEl(`Failed to load profile: ${err.message}`, true));
    }
}

// ── Settings Modal ────────────────────────────────────────
const settingRootServer    = document.getElementById('setting-root-server');
const settingStreamTimeout = document.getElementById('setting-stream-timeout');

function openSettings() {
    settingProxyUrl.value = clientConfig.proxyBase;
    settingNotifyMode.value = clientConfig.notifyMode || 'dm';
    settingRefresh.value = settings.refreshInterval;
    settingRootServer.value = settings.rootServer || '';
    settingStreamTimeout.value = settings.streamTimeout ?? 60;
    settingsModal.style.display = 'flex';
}

async function closeSettings() {
    clearTimeout(searchTimeout);
    const newProxy = settingProxyUrl.value.trim().replace(/\/+$/, '');
    const newNotify = settingNotifyMode.value;
    if (newProxy && isValidHttpsUrl(newProxy)) {
        await saveClientConfig({ ...clientConfig, proxyBase: newProxy, notifyMode: newNotify });
    } else {
        await saveClientConfig({ ...clientConfig, notifyMode: newNotify });
    }
    settingsModal.style.display = 'none';
}

document.getElementById('settings-open-btn').addEventListener('click', openSettings);
document.getElementById('settings-close-btn').addEventListener('click', closeSettings);
settingRefresh.addEventListener('change', e => {
    const val = parseInt(e.target.value) || 0;
    settings.refreshInterval = val === 0 ? 0 : Math.max(30, val);
    settingRefresh.value = settings.refreshInterval;
    saveSettings();
});
settingRootServer.addEventListener('change', () => {
    settings.rootServer = settingRootServer.value.trim().replace(/\/+$/, '');
    saveSettings();
});
settingStreamTimeout.addEventListener('change', e => {
    settings.streamTimeout = Math.max(0, parseInt(e.target.value) || 0);
    settingStreamTimeout.value = settings.streamTimeout;
    saveSettings();
});

document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
        closeSettings();
        closeNewDmModal();
        clearTimeout(searchTimeout);
        postModal.style.display = 'none';
    }
});

// ── Notifications ─────────────────────────────────────────
function sendNotification(title, body) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    if (clientConfig.notifyMode === 'off') return;
    new Notification(title, { body: body.substring(0, 200) });
}

// ── PWA: Inline Manifest ─────────────────────────────────
const pwaIconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><defs><linearGradient id="ig" x1="0%" y1="100%" x2="100%" y2="0%"><stop offset="0%" stop-color="#f09433"/><stop offset="25%" stop-color="#e6683c"/><stop offset="50%" stop-color="#dc2743"/><stop offset="75%" stop-color="#cc2366"/><stop offset="100%" stop-color="#bc1888"/></linearGradient></defs><rect width="512" height="512" rx="96" fill="url(#ig)"/><rect x="96" y="96" width="320" height="320" rx="80" fill="none" stroke="#fff" stroke-width="32"/><circle cx="256" cy="256" r="80" fill="none" stroke="#fff" stroke-width="32"/><circle cx="380" cy="132" r="24" fill="#fff"/></svg>`;
const pwaIconUrl = 'data:image/svg+xml;base64,' + btoa(pwaIconSvg);
const manifest = { name: 'Local Instagram Client', short_name: 'Instagram', description: 'A static Instagram client that runs through a CORS proxy.', start_url: './', display: 'standalone', background_color: '#000000', theme_color: '#000000', icons: [{ src: pwaIconUrl, sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }] };
const manifestBlob = new Blob([JSON.stringify(manifest)], { type: 'application/manifest+json' });
const manifestUrl = URL.createObjectURL(manifestBlob);
const manifestLink = document.createElement('link'); manifestLink.rel = 'manifest'; manifestLink.href = manifestUrl; document.head.appendChild(manifestLink);
const appleIcon = document.createElement('link'); appleIcon.rel = 'apple-touch-icon'; appleIcon.href = pwaIconUrl; document.head.appendChild(appleIcon);

// ── PWA: Inline Service Worker ────────────────────────────
const swCode = `
const CACHE_NAME = 'ig-client-v1';
const SHELL_URLS = [self.registration.scope];
self.addEventListener('install', event => { event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL_URLS))); self.skipWaiting(); });
self.addEventListener('activate', event => { event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))); self.clients.claim(); });
self.addEventListener('fetch', event => {
    const url = new URL(event.request.url);
    if (event.request.mode === 'navigate') { event.respondWith(caches.match(event.request).then(cached => { const fp = fetch(event.request).then(r => { if (r.ok) caches.open(CACHE_NAME).then(c => c.put(event.request, r)); return r.clone(); }).catch(() => cached); return cached || fp; })); return; }
    if (url.pathname === '/image') { event.respondWith(caches.open('ig-media-v1').then(cache => cache.match(event.request).then(cached => { if (cached) return cached; return fetch(event.request).then(r => { if (r.ok) cache.put(event.request, r.clone()); return r; }); }))); return; }
});`;
if ('serviceWorker' in navigator) { const swBlob = new Blob([swCode], { type: 'application/javascript' }); const swUrl = URL.createObjectURL(swBlob); navigator.serviceWorker.register(swUrl, { scope: './' }).catch((e) => { console.warn('[instagram]', e); }); }

// ── Start ─────────────────────────────────────────────────
settingRefresh.value = settings.refreshInterval;
init();
