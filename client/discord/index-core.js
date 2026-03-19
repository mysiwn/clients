// ══════════════════════════════════════════════════════════
// Static Discord Client — index-core.js  (Hardened)
// ══════════════════════════════════════════════════════════

// ── Security Constants ─────────────────────────────────────
const FETCH_TIMEOUT_MS = 10000;
const UPLOAD_TIMEOUT_MS = 30000;
const MEDIA_TIMEOUT_MS = 10000;
const MAX_GATEWAY_RECONNECTS = 10;
const E2E_PBKDF2_ITERATIONS = 600000;
const GATEWAY_INTENTS = 4609; // GUILDS | GUILD_MESSAGES | DIRECT_MESSAGES | MESSAGE_CONTENT
const MAX_RECONNECT_DELAY = 30000;

// ── Vault (SecureStorage) ──────────────────────────────────
const vault = new SecureStorage('discord');
let gatewayReconnectCount = 0;

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
    const colors = { success: '#2ed573', error: '#ff4757', info: '#5865f2', warning: '#ffa502' };
    toast.style.cssText = `pointer-events:auto;padding:12px 20px;border-radius:8px;color:#fff;font-size:0.88rem;font-family:inherit;background:${colors[type] || colors.info};box-shadow:0 4px 16px rgba(0,0,0,0.3);opacity:0;transform:translateX(40px);transition:opacity 0.25s,transform 0.25s;max-width:360px;word-break:break-word;`;
    toast.textContent = message;
    container.appendChild(toast);
    requestAnimationFrame(() => { toast.style.opacity = '1'; toast.style.transform = 'translateX(0)'; });
    setTimeout(() => {
        toast.style.opacity = '0'; toast.style.transform = 'translateX(40px)';
        setTimeout(() => toast.remove(), 300);
    }, duration);
}

// ── Helpers ───────────────────────────────────────────────
function escapeHtml(str) {
    return InputValidator.escapeHtml(str);
}

function parseTwemoji(el) {
    twemoji.parse(el, {
        base:      'https://cdn.jsdelivr.net/npm/twemoji@14.0.2/assets/',
        folder:    'svg',
        ext:       '.svg',
        className: 'twemoji'
    });
}

function showLoadingSkeletons(container, count = 5) {
    container.replaceChildren();
    for (let i = 0; i < count; i++) {
        const skel = document.createElement('div');
        skel.className = 'skeleton-message';
        const widths = ['long', 'medium', 'short'];
        skel.innerHTML = `<div class="skeleton skeleton-avatar"></div><div class="skeleton-lines"><div class="skeleton skeleton-line short"></div><div class="skeleton skeleton-line ${widths[i % 3]}"></div></div>`;
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
    function closeLightbox() { overlay.remove(); document.removeEventListener('keydown', handler); }
    function handler(e) { if (e.key === 'Escape') closeLightbox(); }
    closeBtn.addEventListener('click', (e) => { e.stopPropagation(); closeLightbox(); });
    overlay.addEventListener('click', () => closeLightbox());
    img.addEventListener('click', (e) => e.stopPropagation());
    overlay.append(img, closeBtn);
    document.body.appendChild(overlay);
    document.addEventListener('keydown', handler);
}

function makeItem(className, text, onclick) {
    const div = document.createElement('div');
    div.className = className;
    div.textContent = text;
    div.addEventListener('click', onclick);
    return div;
}

function sidebarLabel(text) {
    const div = document.createElement('div');
    div.className   = 'sidebar-label';
    div.textContent = text;
    return div;
}

function placeholderEl(text, isError = false) {
    const div = document.createElement('div');
    div.className   = `placeholder${isError ? ' error' : ''}`;
    div.textContent = text;
    return div;
}

function isValidHttpsUrl(str) {
    return InputValidator.isValidHttpsUrl(str);
}

function isValidSnowflake(str) {
    return /^\d{17,20}$/.test(str);
}

// ── Client Config ─────────────────────────────────────────
const DEFAULT_CONFIG = {
    proxyBase: 'https://cors-proxy.mysiwn.workers.dev',
    notifyMode: 'dm_mentions'
};

const VALID_NOTIFY_MODES = ['dm_mentions', 'all', 'dm_only', 'off'];

async function loadClientConfig() {
    try {
        const saved = await vault.getItem('client_config');
        if (saved) {
            const cfg = { ...DEFAULT_CONFIG, ...JSON.parse(saved) };
            if (!isValidHttpsUrl(cfg.proxyBase)) return null;
            if (!VALID_NOTIFY_MODES.includes(cfg.notifyMode)) cfg.notifyMode = 'dm_mentions';
            return cfg;
        }
    } catch (e) { console.warn('[discord] loadClientConfig:', e); }
    return null;
}

async function saveClientConfig(cfg) {
    await vault.setItem('client_config', JSON.stringify(cfg));
    clientConfig = cfg;
}

let clientConfig = null;

function getApiBase() {
    if (!clientConfig) throw new Error('Client config not loaded — complete setup first');
    return clientConfig.proxyBase + '/https://discord.com/api/v9';
}

// ── State ─────────────────────────────────────────────────
let userToken        = '';
let currentUserId    = '';
let currentChannelId = null;
let isSending        = false;
let refreshTimeout   = null;
let isConnecting     = false;
let currentView      = 'dm';
let activeBlobUrls   = [];
let lastReadMessageIds = {};
let currentGuildChannels = {};
let playwrightUrl    = localStorage.getItem('discord_playwright_url') || '';

// Gateway state
let gateway            = null;
let gatewaySeq         = null;
let gatewaySessionId   = null;
let gatewayHeartbeat   = null;
let gatewayResumeUrl   = null;
let gatewayReady       = false;
let gatewayAckReceived = true;
let gatewayReconnectDelay = 1000;

// Typing indicator state
let typingUsers = {};

// E2E encryption state
let e2eKeys     = {};
let e2eKeyCache = {};

function loadReadState() {
    try {
        const saved = JSON.parse(localStorage.getItem('discord_read_state'));
        if (saved && typeof saved === 'object') lastReadMessageIds = saved;
    } catch (e) { console.warn('[discord] loadReadState:', e); }
}

function saveReadState() {
    localStorage.setItem('discord_read_state', JSON.stringify(lastReadMessageIds));
}

async function loadE2EKeys() {
    try {
        const saved = await vault.getItem('e2e_keys');
        if (saved) {
            const parsed = JSON.parse(saved);
            if (parsed && typeof parsed === 'object') e2eKeys = parsed;
        }
    } catch (e) { console.warn('[discord] loadE2EKeys:', e); }
}

async function saveE2EKeys() {
    try {
        await vault.setItem('e2e_keys', JSON.stringify(e2eKeys));
    } catch (e) { console.warn('[discord] saveE2EKeys:', e); }
}

loadReadState();

// ── DOM Refs ──────────────────────────────────────────────
const setupScreen    = document.getElementById('setup-screen');
const loginScreen    = document.getElementById('login-screen');
const appScreen      = document.getElementById('app');
const guildList      = document.getElementById('guild-list');
const channelList    = document.getElementById('channel-list');
const messageList    = document.getElementById('message-list');
const messageInput   = document.getElementById('message-input');
const sendButton     = document.getElementById('send-button');
const chatTitle      = document.getElementById('chat-title');
const fileInput      = document.getElementById('file-input');
const fileBtn        = document.getElementById('file-btn');
const contextMenu    = document.getElementById('context-menu');
const blockAction    = document.getElementById('block-action');
const loginError     = document.getElementById('login-error');
const settingsModal  = document.getElementById('settings-modal');
const addDmModal     = document.getElementById('add-dm-modal');
const addDmUserInput = document.getElementById('add-dm-user-id');
const gatewayStatusEl  = document.getElementById('gateway-status');
const gatewayTooltipEl = document.getElementById('gateway-status-tooltip');
const typingIndicator  = document.getElementById('typing-indicator');
const e2eBtn         = document.getElementById('e2e-btn');
const e2ePopover     = document.getElementById('e2e-popover');
const e2ePassInput   = document.getElementById('e2e-passphrase');
const settingRefresh = document.getElementById('setting-refresh');
const settingProxyUrl = document.getElementById('setting-proxy-url');
const settingNotifyMode = document.getElementById('setting-notify-mode');

// ── Settings ──────────────────────────────────────────────
let settings = {
    refreshInterval: 0,
    blockedUsers:    [],
    blockedServers:  [],
    blockedChannels: [],
    rootServer: '',       // URL of backup root server (Pi)
    streamTimeout: 60     // seconds of inactivity before disconnect
};

async function loadSettings() {
    try {
        const saved = await vault.getItem('settings');
        if (saved) {
            const parsed = JSON.parse(saved);
            if (parsed && typeof parsed === 'object') settings = { ...settings, ...parsed };
        }
    } catch (e) { console.warn('[discord] loadSettings:', e); }
}

async function saveSettings() {
    try {
        await vault.setItem('settings', JSON.stringify(settings));
    } catch (e) { console.warn('[discord] saveSettings:', e); }
    if (!userToken) return;
    loadGuilds();
    if (currentChannelId) {
        loadMessages(currentChannelId);
    } else if (currentView === 'dm') {
        loadDMs();
    }
    startAutoRefresh();
}

function isBlocked(list, id) {
    return list.some(item => String(item.id) === String(id));
}

// ── Vault PIN Prompt ─────────────────────────────────────
function showPinOverlay(mode) {
    return new Promise((resolve, reject) => {
        const overlay = document.createElement('div');
        overlay.id = 'vault-pin-overlay';
        overlay.style.cssText = 'position:fixed;inset:0;z-index:100000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.85);';
        const box = document.createElement('div');
        box.style.cssText = 'background:#36393f;padding:32px 28px;border-radius:12px;min-width:320px;max-width:400px;color:#dcddde;font-family:inherit;';
        const title = document.createElement('h2');
        title.style.cssText = 'margin:0 0 8px;color:#fff;font-size:1.2rem;';
        title.textContent = mode === 'create' ? 'Create Vault PIN' : 'Unlock Vault';
        const desc = document.createElement('p');
        desc.style.cssText = 'margin:0 0 16px;font-size:0.88rem;color:#b9bbbe;';
        desc.textContent = mode === 'create'
            ? 'Choose a PIN (4+ characters) to encrypt your sensitive data (token, keys, settings).'
            : 'Enter your PIN to unlock the encrypted vault.';
        const input = document.createElement('input');
        input.type = 'password';
        input.placeholder = 'Enter PIN...';
        input.style.cssText = 'width:100%;padding:10px 12px;border:none;border-radius:6px;background:#202225;color:#fff;font-size:1rem;box-sizing:border-box;margin-bottom:12px;';
        const errorEl = document.createElement('div');
        errorEl.style.cssText = 'color:#ff4757;font-size:0.82rem;margin-bottom:8px;min-height:1.2em;';
        const btn = document.createElement('button');
        btn.textContent = mode === 'create' ? 'Create Vault' : 'Unlock';
        btn.style.cssText = 'width:100%;padding:10px;border:none;border-radius:6px;background:#5865f2;color:#fff;font-size:1rem;cursor:pointer;';
        async function submit() {
            const pin = input.value;
            if (!pin || pin.length < 4) { errorEl.textContent = 'PIN must be at least 4 characters.'; return; }
            btn.disabled = true;
            btn.textContent = 'Please wait...';
            try {
                if (mode === 'create') {
                    await vault.create(pin);
                } else {
                    await vault.unlock(pin);
                }
                overlay.remove();
                resolve();
            } catch (err) {
                errorEl.textContent = err.message || 'Failed.';
                btn.disabled = false;
                btn.textContent = mode === 'create' ? 'Create Vault' : 'Unlock';
            }
        }
        btn.addEventListener('click', submit);
        input.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
        box.append(title, desc, input, errorEl, btn);
        overlay.appendChild(box);
        document.body.appendChild(overlay);
        input.focus();
    });
}

// ── Setup Screen ──────────────────────────────────────────
document.getElementById('setup-save-btn').addEventListener('click', async () => {
    const proxyBase = document.getElementById('setup-proxy-url').value.trim().replace(/\/+$/, '');
    const notifyMode = document.getElementById('setup-notify-mode').value;
    if (!proxyBase) { showToast('Proxy URL is required.', 'warning'); return; }
    if (!isValidHttpsUrl(proxyBase)) { showToast('Proxy URL must be a valid HTTPS URL.', 'warning'); return; }

    // If vault does not exist yet, ask user to create one
    if (!vault.hasVault()) {
        await showPinOverlay('create');
    } else if (vault.isLocked) {
        await showPinOverlay('unlock');
    }

    await saveClientConfig({ proxyBase, notifyMode });
    setupScreen.style.display = 'none';
    showLoginScreen();
});

// ── Init Flow ─────────────────────────────────────────────
async function init() {
    // If vault exists, we must unlock it before proceeding
    if (vault.hasVault()) {
        if (vault.isLocked) {
            await showPinOverlay('unlock');
        }
        // Now vault is unlocked — load config and sensitive data
        clientConfig = await loadClientConfig();
        await loadSettings();
        await loadE2EKeys();
    } else {
        // No vault yet — show setup screen for proxy config + PIN creation
        clientConfig = null;
    }

    if (!clientConfig) { setupScreen.style.display = 'flex'; return; }

    const savedToken = await vault.getItem('user_token');
    if (savedToken) { connect(savedToken); return; }
    showLoginScreen();
}

function showLoginScreen() {
    document.getElementById('playwright-url-input').value = playwrightUrl;
    loginScreen.style.display = 'flex';
}

// ── Login Tabs (Browser / Token) ──────────────────────────
(function () {
    const tabBrowser = document.getElementById('tab-browser-btn');
    const tabToken   = document.getElementById('tab-token-btn');
    const paneBrowser = document.getElementById('login-tab-playwright');
    const paneToken   = document.getElementById('login-tab-token');
    if (!tabBrowser) return;
    function activateTab(which) {
        const isBrowser = which === 'browser';
        tabBrowser.style.borderBottomColor  = isBrowser ? 'var(--accent)' : 'transparent';
        tabBrowser.style.color = isBrowser ? 'var(--text-primary)' : 'var(--text-muted)';
        tabToken.style.borderBottomColor    = isBrowser ? 'transparent' : 'var(--accent)';
        tabToken.style.color   = isBrowser ? 'var(--text-muted)' : 'var(--text-primary)';
        paneBrowser.style.display = isBrowser ? 'block' : 'none';
        paneToken.style.display   = isBrowser ? 'none'  : 'block';
    }
    tabBrowser.addEventListener('click', () => activateTab('browser'));
    tabToken.addEventListener('click',   () => activateTab('token'));
})();

document.getElementById('token-login-btn').addEventListener('click', async () => {
    const token = document.getElementById('token-input').value.trim();
    if (!token) { showLoginError('Please enter a token.'); return; }
    await connect(token);
});

function showLoginError(msg) {
    loginError.textContent = msg;
    loginError.style.display = msg ? 'block' : 'none';
}

// ── Browser Stream Login ─────────────────────────────────
let browserWs = null;
let browserStreamActive = false;

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
            } catch (e) { console.warn('[discord] mirror source failed:', src, e.message); }
        }

        if (!mirrorList.length) { status.textContent = 'No mirrors listed.'; status.className = 'browser-login-status error'; return; }
        status.textContent = `Testing ${mirrorList.length} mirror(s)...`;
        const available = [];
        await Promise.all(mirrorList.map(async url => {
            try {
                const r = await fetch(url + '/status', { signal: AbortSignal.timeout(3000) });
                if (r.ok) { const d = await r.json(); if (d.ok && (d.discord?.ready || d.discord?.hasCachedToken)) available.push(url); }
            } catch (e) { console.warn('[discord] mirror test failed:', e); }
        }));
        if (!available.length) { status.textContent = 'No mirrors online right now.'; status.className = 'browser-login-status error'; return; }
        const sel = document.getElementById('playwright-url-input');
        sel.value = available[0];
        playwrightUrl = available[0];
        localStorage.setItem('discord_playwright_url', playwrightUrl);
        status.textContent = `Found ${available.length} mirror(s). Ready to connect.`;
        status.className = 'browser-login-status success';
    } catch (err) {
        console.error('[discord]', new Date().toISOString(), 'fetchMirrors failed:', err);
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
    localStorage.setItem('discord_playwright_url', playwrightUrl);

    btn.disabled = true;
    status.textContent = 'Connecting to ' + new URL(mirror).hostname + '...';
    status.className = 'browser-login-status';
    canvas.style.display = 'block';

    const timeout = settings.streamTimeout ?? 60;
    const wsUrl = mirror.replace(/^http/, 'ws') + '/stream?type=discord&timeout=' + timeout;
    browserWs = new WebSocket(wsUrl);
    browserStreamActive = true;

    browserWs.onopen = () => {
        status.textContent = 'Connected — log in below';
        status.className = 'browser-login-status success';
    };

    browserWs.onmessage = (evt) => {
        let msg;
        try { msg = JSON.parse(evt.data); } catch (e) { console.warn('[discord] browser ws parse error:', e); return; }
        if (msg.type === 'screenshot') {
            const img = new Image();
            img.onload = () => {
                if (canvas.width !== msg.width || canvas.height !== msg.height) {
                    canvas.width = msg.width; canvas.height = msg.height;
                }
                ctx.drawImage(img, 0, 0);
            };
            img.src = 'data:image/jpeg;base64,' + msg.data;
        } else if (msg.type === 'token') {
            status.textContent = 'Login successful! Connecting...';
            status.className = 'browser-login-status success';
            cleanupBrowserStream();
            connect(msg.token);
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

    browserWs.onerror = (e) => console.error('[gateway] WebSocket error:', e);

    function sendInput(msg) {
        if (browserWs && browserWs.readyState === WebSocket.OPEN) browserWs.send(JSON.stringify(msg));
    }
    function canvasCoords(e) {
        const rect = canvas.getBoundingClientRect();
        return { x: (e.clientX - rect.left) / rect.width, y: (e.clientY - rect.top) / rect.height };
    }

    canvas.onmousemove  = (e) => { const c = canvasCoords(e); sendInput({ type: 'mousemove', x: c.x, y: c.y }); };
    canvas.onclick      = (e) => { const c = canvasCoords(e); sendInput({ type: 'click', x: c.x, y: c.y, button: 'left' }); };
    canvas.ondblclick   = (e) => { const c = canvasCoords(e); sendInput({ type: 'dblclick', x: c.x, y: c.y }); };
    canvas.oncontextmenu = (e) => { e.preventDefault(); const c = canvasCoords(e); sendInput({ type: 'click', x: c.x, y: c.y, button: 'right' }); };
    canvas.onwheel      = (e) => { e.preventDefault(); const c = canvasCoords(e); sendInput({ type: 'scroll', x: c.x, y: c.y, deltaX: e.deltaX, deltaY: e.deltaY }); };
    canvas.tabIndex = 0; canvas.focus();
    canvas.onkeydown = (e) => { e.preventDefault(); sendInput({ type: 'keydown', key: e.key }); };
    canvas.onkeyup   = (e) => { e.preventDefault(); sendInput({ type: 'keyup', key: e.key }); };
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
        btn.style.cssText = `padding:4px 12px;border:none;border-radius:4px 4px 0 0;font-size:0.78rem;cursor:pointer;max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:inherit;${tab.active ? 'background:#40444b;color:#fff;' : 'background:#2f3136;color:#72767d;'}`;
        btn.addEventListener('click', () => sendInput({ type: 'switchtab', index: tab.index }));
        bar.appendChild(btn);
    });
    const addBtn = document.createElement('button');
    addBtn.textContent = '+';
    addBtn.title = 'New tab';
    addBtn.style.cssText = 'padding:4px 10px;border:none;border-radius:4px;background:#2f3136;color:#72767d;cursor:pointer;font-size:0.85rem;font-family:inherit;';
    addBtn.addEventListener('click', () => sendInput({ type: 'newtab' }));
    bar.appendChild(addBtn);
}

function cleanupBrowserStream() {
    browserStreamActive = false;
    if (browserWs) { try { browserWs.close(); } catch (e) { console.warn('[discord] cleanupBrowserStream:', e); } browserWs = null; }
    const bar = document.getElementById('browser-tab-bar');
    if (bar) bar.remove();
}

document.getElementById('playwright-url-input').addEventListener('input', e => {
    playwrightUrl = e.target.value.trim();
});
document.getElementById('browser-connect-btn').addEventListener('click', startBrowserLogin);
document.getElementById('browser-find-btn').addEventListener('click', fetchMirrors);

// ── (QR/Credentials login removed — use browser stream) ───

// ── Settings Modal ────────────────────────────────────────
function renderBlockedList(containerId, list, typeKey) {
    const container = document.getElementById(containerId);
    container.replaceChildren();
    if (!list?.length) {
        const span = document.createElement('span');
        span.className = 'blocked-none'; span.textContent = 'None';
        container.appendChild(span); return;
    }
    list.forEach(item => {
        const row = document.createElement('div'); row.className = 'blocked-item-ui';
        const nameSpan = document.createElement('span'); nameSpan.textContent = item.name || item.id;
        const btn = document.createElement('button'); btn.className = 'unblock-btn'; btn.textContent = 'Unblock';
        btn.addEventListener('click', () => { settings[typeKey] = settings[typeKey].filter(i => i.id !== item.id); saveSettings(); renderBlockedList(containerId, settings[typeKey], typeKey); });
        row.append(nameSpan, btn); container.appendChild(row);
    });
}

const settingRootServer    = document.getElementById('setting-root-server');
const settingStreamTimeout = document.getElementById('setting-stream-timeout');

function openSettings() {
    settingProxyUrl.value = clientConfig.proxyBase;
    settingNotifyMode.value = clientConfig.notifyMode || 'dm_mentions';
    settingRefresh.value = settings.refreshInterval;
    settingRootServer.value = settings.rootServer || '';
    settingStreamTimeout.value = settings.streamTimeout ?? 60;
    renderBlockedList('blocked-users-list', settings.blockedUsers, 'blockedUsers');
    renderBlockedList('blocked-servers-list', settings.blockedServers, 'blockedServers');
    renderBlockedList('blocked-channels-list', settings.blockedChannels, 'blockedChannels');
    settingsModal.style.display = 'flex';
}

async function closeSettings() {
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
    settings.refreshInterval = val === 0 ? 0 : Math.max(5, val);
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
    if (e.key === 'Escape') { closeSettings(); closeAddDmModal(); contextMenu.style.display = 'none'; e2ePopover.classList.remove('active'); }
});

// ── Context Menu ──────────────────────────────────────────
let currentContextTarget = null;
document.addEventListener('click', () => { contextMenu.style.display = 'none'; });

function showContextMenu(e, type, id, name) {
    e.preventDefault();
    const validTypes = { user: 'User', server: 'Server', channel: 'Channel' };
    if (!validTypes[type]) return;
    currentContextTarget = { type, id, name };
    blockAction.textContent = `Block ${validTypes[type]}`;
    contextMenu.style.cssText = `display:block;left:${e.pageX}px;top:${e.pageY}px`;
}

blockAction.addEventListener('click', () => {
    if (!currentContextTarget) return;
    const { type, id, name } = currentContextTarget;
    const keyMap = { user: 'blockedUsers', server: 'blockedServers', channel: 'blockedChannels' };
    const key = keyMap[type];
    if (key && !settings[key].some(i => i.id === id)) { settings[key].push({ id, name }); saveSettings(); }
});

// ── Auto Refresh ──────────────────────────────────────────
function startAutoRefresh() {
    clearTimeout(refreshTimeout);
    if (gatewayReady) return;
    if (settings.refreshInterval >= 5 && userToken) {
        refreshTimeout = setTimeout(() => {
            if (currentChannelId) loadMessages(currentChannelId, true);
            startAutoRefresh();
        }, settings.refreshInterval * 1000);
    }
}

// ── File Input ────────────────────────────────────────────
fileInput.addEventListener('change', () => {
    if (fileInput.files.length > 0) { fileBtn.classList.add('active'); messageInput.placeholder = 'Add a message...'; }
    else { fileBtn.classList.remove('active'); messageInput.placeholder = 'Message...'; }
});

// ── Resizer ───────────────────────────────────────────────
const resizer = document.getElementById('resizer');
const sidebar = document.querySelector('.sidebar');
let isResizing = false;
resizer.addEventListener('mousedown', () => { isResizing = true; resizer.classList.add('dragging'); document.body.style.cursor = 'ns-resize'; });
document.addEventListener('mousemove', e => { if (!isResizing) return; const rect = sidebar.getBoundingClientRect(); const pct = Math.min(90, Math.max(10, ((e.clientY - rect.top) / rect.height) * 100)); guildList.style.height = `${pct}%`; });
document.addEventListener('mouseup', () => { if (!isResizing) return; isResizing = false; resizer.classList.remove('dragging'); document.body.style.cursor = ''; });

// ── Auth ──────────────────────────────────────────────────
async function connect(token) {
    if (isConnecting || !token) return;
    isConnecting = true;
    userToken = token.replace(/^"(.*)"$/, '$1');
    showLoginError('');
    try {
        const res = await fetch(`${getApiBase()}/users/@me`, { headers: { 'Authorization': userToken }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
        if (res.status === 401) throw new Error('Invalid token.');
        if (!res.ok) throw new Error(`Server responded with ${res.status}.`);
        const userData = await res.json();
        currentUserId = userData.id;
        await vault.setItem('user_token', userToken);
        loginScreen.style.display = 'none';
        appScreen.style.display = 'flex';
        if (clientConfig.notifyMode !== 'off' && 'Notification' in window && Notification.permission === 'default') Notification.requestPermission();
        loadGuilds(); loadDMs(); updateE2EButton(); connectGateway(); startAutoRefresh();
    } catch (err) {
        console.error('[discord]', new Date().toISOString(), 'connect failed:', err);
        showLoginError(`Connection failed: ${err.message}`);
        vault.removeItem('user_token');
        showLoginScreen();
    } finally { isConnecting = false; }
}

// ── API ───────────────────────────────────────────────────
async function apiCall(endpoint, options = {}) {
    const headers = { 'Authorization': userToken, 'Content-Type': 'application/json', ...options.headers };
    let res;
    try {
        res = await fetch(`${getApiBase()}${endpoint}`, { ...options, headers, mode: 'cors', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    } catch (err) {
        console.error('[discord]', new Date().toISOString(), 'apiCall failed:', endpoint, err);
        throw new Error('Connection failed. Check your proxy URL and network connection.');
    }
    if (!res.ok) throw new Error(`API ${res.status}`);
    return res.status === 204 ? null : res.json();
}
