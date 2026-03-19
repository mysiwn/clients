// ══════════════════════════════════════════════════════════
// Static Discord Client — index.js  (Hardened)
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

// ══════════════════════════════════════════════════════════
// PHASE 2: Discord Gateway WebSocket
// ══════════════════════════════════════════════════════════

function setGatewayStatus(status, tooltip) {
    gatewayStatusEl.className = 'gateway-status ' + status;
    gatewayTooltipEl.textContent = tooltip;
}

function connectGateway() {
    if (gateway && gateway.readyState === WebSocket.OPEN) return;

    if (gatewayReconnectCount >= MAX_GATEWAY_RECONNECTS) {
        setGatewayStatus('disconnected', 'Max reconnect attempts reached');
        showToast('Gateway: max reconnect attempts reached. Using polling.', 'warning');
        startAutoRefresh();
        return;
    }

    gatewayReconnectCount++;
    setGatewayStatus('reconnecting', 'Connecting...');
    const url = gatewayResumeUrl || 'wss://gateway.discord.gg/?v=9&encoding=json';
    const ws = new WebSocket(url);
    gateway = ws;

    ws.onopen = () => { gatewayReconnectDelay = 1000; };
    ws.onclose = () => {
        clearInterval(gatewayHeartbeat); gatewayHeartbeat = null; gatewayReady = false; typingUsers = {}; renderTypingIndicator();
        setGatewayStatus('disconnected', 'Disconnected \u2014 using polling');
        if (gateway === ws && userToken) {
            startAutoRefresh();
            setTimeout(() => { if (userToken) connectGateway(); }, gatewayReconnectDelay);
            gatewayReconnectDelay = Math.min(gatewayReconnectDelay * 2, MAX_RECONNECT_DELAY);
        }
    };
    ws.onerror = (e) => console.error('[gateway] WebSocket error:', e);
    ws.onmessage = (event) => {
        let msg;
        try { msg = JSON.parse(event.data); } catch (e) { console.warn('[discord] gateway parse error:', e); return; }
        if (msg.s !== null && msg.s !== undefined) gatewaySeq = msg.s;
        switch (msg.op) {
            case 10:
                startGatewayHeartbeat(msg.d.heartbeat_interval);
                if (gatewaySessionId && gatewaySeq !== null) {
                    ws.send(JSON.stringify({ op: 6, d: { token: userToken, session_id: gatewaySessionId, seq: gatewaySeq } }));
                } else {
                    ws.send(JSON.stringify({ op: 2, d: { token: userToken, intents: GATEWAY_INTENTS, properties: { os: 'browser', browser: 'chrome', device: '' } } }));
                }
                break;
            case 0: handleGatewayDispatch(msg.t, msg.d); break;
            case 1: ws.send(JSON.stringify({ op: 1, d: gatewaySeq })); break;
            case 7: ws.close(); break;
            case 9:
                gatewaySessionId = null; gatewaySeq = null;
                if (!msg.d) gatewayResumeUrl = null;
                setTimeout(() => { if (userToken) connectGateway(); }, 1000 + Math.random() * 4000);
                break;
            case 11: gatewayAckReceived = true; break;
        }
    };
}

function startGatewayHeartbeat(interval) {
    clearInterval(gatewayHeartbeat); gatewayAckReceived = true;
    setTimeout(() => { if (gateway?.readyState === WebSocket.OPEN) gateway.send(JSON.stringify({ op: 1, d: gatewaySeq })); }, interval * Math.random());
    gatewayHeartbeat = setInterval(() => {
        if (!gatewayAckReceived) { gateway?.close(); return; }
        gatewayAckReceived = false;
        if (gateway?.readyState === WebSocket.OPEN) gateway.send(JSON.stringify({ op: 1, d: gatewaySeq }));
    }, interval);
}

function handleGatewayDispatch(event, data) {
    switch (event) {
        case 'READY':
            gatewaySessionId = data.session_id;
            gatewayResumeUrl = data.resume_gateway_url ? data.resume_gateway_url + '/?v=9&encoding=json' : null;
            gatewayReady = true; gatewayReconnectCount = 0; setGatewayStatus('connected', 'Connected \u2014 real-time'); clearTimeout(refreshTimeout);
            break;
        case 'RESUMED':
            gatewayReady = true; gatewayReconnectCount = 0; setGatewayStatus('connected', 'Connected \u2014 real-time'); clearTimeout(refreshTimeout);
            break;
        case 'MESSAGE_CREATE': handleNewMessage(data); break;
        case 'MESSAGE_UPDATE': handleMessageUpdate(data); break;
        case 'MESSAGE_DELETE': handleMessageDelete(data); break;
        case 'TYPING_START': handleTypingStart(data); break;
        case 'GUILD_CREATE': case 'GUILD_DELETE': case 'GUILD_UPDATE': loadGuilds(); break;
        case 'CHANNEL_CREATE': case 'CHANNEL_DELETE': case 'CHANNEL_UPDATE': if (currentView === 'dm') loadDMs(); break;
    }
}

async function handleNewMessage(data) {
    if (data.channel_id !== currentChannelId) {
        const channelEl = document.querySelector(`.channel-item[data-channel-id="${CSS.escape(data.channel_id)}"]`);
        if (channelEl) channelEl.classList.add('unread');
        if (shouldNotify(data.channel_id, data)) sendNotification(data, data.channel_id);
        return;
    }
    if (data.author && isBlocked(settings.blockedUsers, data.author.id)) return;
    const content = await e2eDecryptContent(data.channel_id, data.content);
    const isEncrypted = content !== data.content;
    const div = buildMessage({ ...data, content, _e2eDecrypted: isEncrypted });
    messageList.appendChild(div); parseTwemoji(div); loadMediaInMessage(div);
    messageList.scrollTop = messageList.scrollHeight;
    markChannelRead(data.channel_id, data.id);
    clearTypingUser(data.author?.id);
}

function handleMessageUpdate(data) {
    if (data.channel_id !== currentChannelId) return;
    const msgEl = messageList.querySelector(`[data-msg-id="${CSS.escape(data.id)}"]`);
    if (!msgEl) return;
    const contentEl = msgEl.querySelector('.content');
    if (contentEl && data.content !== undefined) { contentEl.textContent = data.content; parseTwemoji(contentEl); }
}

function handleMessageDelete(data) {
    if (data.channel_id !== currentChannelId) return;
    const msgEl = messageList.querySelector(`[data-msg-id="${CSS.escape(data.id)}"]`);
    if (msgEl) msgEl.remove();
}

function handleTypingStart(data) {
    if (data.channel_id !== currentChannelId || data.user_id === currentUserId) return;
    const username = data.member?.nick || data.member?.user?.global_name || data.member?.user?.username || 'Someone';
    typingUsers[data.user_id] = { username, expires: Date.now() + 8000 };
    renderTypingIndicator();
    setTimeout(() => { if (typingUsers[data.user_id]?.expires <= Date.now()) { delete typingUsers[data.user_id]; renderTypingIndicator(); } }, 8100);
}

function clearTypingUser(userId) {
    if (userId && typingUsers[userId]) { delete typingUsers[userId]; renderTypingIndicator(); }
}

function renderTypingIndicator() {
    const now = Date.now();
    const active = Object.values(typingUsers).filter(u => u.expires > now);
    if (active.length === 0) { typingIndicator.textContent = ''; return; }
    const names = active.map(u => u.username);
    let text;
    if (names.length === 1) text = `${names[0]} is typing`;
    else if (names.length === 2) text = `${names[0]} and ${names[1]} are typing`;
    else text = `${names[0]} and ${names.length - 1} others are typing`;
    typingIndicator.replaceChildren();
    const span = document.createElement('span'); span.textContent = text;
    const dots = document.createElement('span'); dots.className = 'typing-dots';
    typingIndicator.append(span, dots);
}

// ══════════════════════════════════════════════════════════
// PHASE 3: E2E Encryption
// ══════════════════════════════════════════════════════════

async function deriveE2EKey(passphrase, channelId) {
    const enc = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
    // Generate and store a random salt per channel (or reuse existing one)
    let saltB64 = e2eKeys['_salt_' + channelId];
    let salt;
    if (saltB64) {
        salt = Uint8Array.from(atob(saltB64), c => c.charCodeAt(0));
    } else {
        salt = crypto.getRandomValues(new Uint8Array(32));
        saltB64 = btoa(String.fromCharCode(...salt));
        e2eKeys['_salt_' + channelId] = saltB64;
        await saveE2EKeys();
    }
    return crypto.subtle.deriveKey(
        { name: 'PBKDF2', salt, iterations: E2E_PBKDF2_ITERATIONS, hash: 'SHA-256' },
        keyMaterial, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
    );
}

async function getE2EKey(channelId) {
    if (!e2eKeys[channelId]) return null;
    if (!e2eKeyCache[channelId]) e2eKeyCache[channelId] = await deriveE2EKey(e2eKeys[channelId], channelId);
    return e2eKeyCache[channelId];
}

async function e2eEncrypt(channelId, plaintext) {
    const key = await getE2EKey(channelId);
    if (!key) return plaintext;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encoded = new TextEncoder().encode(plaintext);
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);
    const combined = new Uint8Array(iv.length + ciphertext.byteLength);
    combined.set(iv); combined.set(new Uint8Array(ciphertext), iv.length);
    return '\u{1F512}' + btoa(String.fromCharCode(...combined));
}

async function e2eDecrypt(channelId, message) {
    if (!message || !message.startsWith('\u{1F512}')) return message;
    const key = await getE2EKey(channelId);
    if (!key) return '[Encrypted message]';
    try {
        const data = Uint8Array.from(atob(message.slice(2)), c => c.charCodeAt(0));
        const iv = data.slice(0, 12), ciphertext = data.slice(12);
        const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
        return new TextDecoder().decode(decrypted);
    } catch (e) { console.warn('[discord] e2eDecrypt failed:', e); return '[Decryption failed \u2014 wrong key?]'; }
}

async function e2eDecryptContent(channelId, content) {
    if (!content || !content.startsWith('\u{1F512}')) return content;
    return e2eDecrypt(channelId, content);
}

function updateE2EButton() {
    if (currentChannelId && e2eKeys[currentChannelId]) {
        e2eBtn.classList.add('active'); e2eBtn.textContent = '\u{1F512}';
    } else {
        e2eBtn.classList.remove('active'); e2eBtn.textContent = '\u{1F513}';
    }
}

e2eBtn.addEventListener('click', () => {
    e2ePopover.classList.toggle('active');
    if (e2ePopover.classList.contains('active')) { e2ePassInput.value = e2eKeys[currentChannelId] || ''; e2ePassInput.focus(); }
});

document.getElementById('e2e-save-btn').addEventListener('click', async () => {
    const passphrase = e2ePassInput.value.trim();
    if (!passphrase || !currentChannelId) return;
    e2eKeys[currentChannelId] = passphrase;
    delete e2eKeyCache[currentChannelId];
    await saveE2EKeys(); updateE2EButton(); e2ePopover.classList.remove('active');
});

document.getElementById('e2e-clear-btn').addEventListener('click', async () => {
    if (!currentChannelId) return;
    delete e2eKeys[currentChannelId]; delete e2eKeyCache[currentChannelId];
    await saveE2EKeys(); updateE2EButton(); e2ePopover.classList.remove('active');
});

// ── Notifications ─────────────────────────────────────────
function shouldNotify(channelId, msg) {
    if (!clientConfig || clientConfig.notifyMode === 'off') return false;
    if ('Notification' in window && Notification.permission !== 'granted') return false;
    if (msg.author?.id === currentUserId) return false;
    const mode = clientConfig.notifyMode, isDm = currentView === 'dm' || !channelId;
    if (mode === 'dm_only') return isDm;
    if (mode === 'dm_mentions') return isDm || (msg.content && msg.content.includes(`<@${currentUserId}>`));
    if (mode === 'all') return true;
    return false;
}

function sendNotification(msg, channelId) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    const authorName = msg.author?.global_name || msg.author?.username || 'Unknown';
    const body = msg.content ? msg.content.substring(0, 200) : '(attachment)';
    const n = new Notification(authorName, { body, tag: `msg-${msg.id}` });
    n.onclick = () => { window.focus(); if (channelId !== currentChannelId) loadMessages(channelId); };
}

// ── Guilds ────────────────────────────────────────────────
async function loadGuilds() {
    try {
        const guilds = await apiCall('/users/@me/guilds');
        guildList.replaceChildren(); guildList.appendChild(sidebarLabel('Servers'));
        const dmDiv = makeItem('guild-item active', 'Direct Messages', e => { setActiveGuild(e.currentTarget); currentView = 'dm'; loadDMs(); });
        guildList.appendChild(dmDiv);
        guilds.forEach(guild => {
            if (isBlocked(settings.blockedServers, guild.id)) return;
            const div = makeItem('guild-item', guild.name, e => { setActiveGuild(e.currentTarget); currentView = 'guild'; loadChannels(guild.id); });
            div.dataset.guildId = guild.id;
            div.addEventListener('contextmenu', e => showContextMenu(e, 'server', guild.id, guild.name));
            guildList.appendChild(div); parseTwemoji(div);
        });
    } catch (err) { console.error('[discord]', new Date().toISOString(), 'Failed to load guilds:', err); }
}

function setActiveGuild(el) { document.querySelectorAll('.guild-item').forEach(e => e.classList.remove('active')); el.classList.add('active'); }
function setActiveChannel(el, name) { document.querySelectorAll('.channel-item').forEach(e => e.classList.remove('active')); el.classList.add('active'); el.classList.remove('unread'); chatTitle.textContent = name; }

// ── DMs ───────────────────────────────────────────────────
async function loadDMs() {
    try {
        channelList.replaceChildren();
        const label = sidebarLabel('Direct Messages');
        const addBtn = document.createElement('span'); addBtn.className = 'sidebar-label-add'; addBtn.textContent = '+'; addBtn.title = 'Open DM';
        addBtn.addEventListener('click', openAddDmModal); label.appendChild(addBtn); channelList.appendChild(label);
        const dms = await apiCall('/users/@me/channels');
        dms.sort((a, b) => { try { const idA = BigInt(a.last_message_id || 0), idB = BigInt(b.last_message_id || 0); return idA < idB ? 1 : idA > idB ? -1 : 0; } catch (e) { console.warn('[discord] sort error:', e); return 0; } });
        dms.forEach(ch => {
            if (isBlocked(settings.blockedChannels, ch.id)) return;
            const name = ch.name || ch.recipients?.map(r => r.global_name || r.username).join(', ') || 'Unknown';
            const div = makeItem('channel-item', name, e => { setActiveChannel(e.currentTarget, name); markChannelRead(ch.id, ch.last_message_id); loadMessages(ch.id); });
            if (ch.last_message_id && isChannelUnread(ch.id, ch.last_message_id)) div.classList.add('unread');
            div.dataset.channelId = ch.id;
            div.addEventListener('contextmenu', e => showContextMenu(e, 'channel', ch.id, name));
            channelList.appendChild(div); parseTwemoji(div);
        });
    } catch (err) { console.error('[discord]', new Date().toISOString(), 'Failed to load DMs:', err); }
}

// ── Channels ──────────────────────────────────────────────
async function loadChannels(guildId) {
    try {
        channelList.replaceChildren(); channelList.appendChild(sidebarLabel('Text Channels'));
        const channels = await apiCall(`/guilds/${guildId}/channels`);
        const textChannels = channels.filter(c => c.type === 0).sort((a, b) => a.position - b.position);
        currentGuildChannels[guildId] = textChannels;
        let hasUnread = false;
        textChannels.forEach(ch => {
            if (isBlocked(settings.blockedChannels, ch.id)) return;
            const displayName = `# ${ch.name}`;
            const div = makeItem('channel-item', displayName, e => { setActiveChannel(e.currentTarget, displayName); markChannelRead(ch.id, ch.last_message_id); loadMessages(ch.id); });
            if (ch.last_message_id && isChannelUnread(ch.id, ch.last_message_id)) { div.classList.add('unread'); hasUnread = true; }
            div.dataset.channelId = ch.id;
            div.addEventListener('contextmenu', e => showContextMenu(e, 'channel', ch.id, displayName));
            channelList.appendChild(div); parseTwemoji(div);
        });
        const guildEl = document.querySelector(`.guild-item[data-guild-id="${CSS.escape(guildId)}"]`);
        if (guildEl) guildEl.classList.toggle('unread', hasUnread);
    } catch (err) { console.error('[discord]', new Date().toISOString(), 'Failed to load channels:', err); }
}

// ── Unread State ──────────────────────────────────────────
function isChannelUnread(channelId, lastMessageId) {
    if (!lastMessageId) return false;
    const lastRead = lastReadMessageIds[channelId];
    if (!lastRead) return true;
    try { return BigInt(lastMessageId) > BigInt(lastRead); } catch (e) { console.warn('[discord] isChannelUnread:', e); return lastMessageId !== lastRead; }
}

function markChannelRead(channelId, lastMessageId) {
    if (lastMessageId) { lastReadMessageIds[channelId] = lastMessageId; saveReadState(); }
}

// ── Messages ──────────────────────────────────────────────
async function loadMessages(channelId, silent = false) {
    currentChannelId = channelId;
    messageInput.disabled = false; sendButton.disabled = false;
    fileBtn.style.pointerEvents = 'auto'; fileBtn.style.opacity = '1';
    updateE2EButton(); typingUsers = {}; renderTypingIndicator();

    const prevScrollTop = messageList.scrollTop, prevScrollHeight = messageList.scrollHeight;
    const atBottom = (prevScrollHeight - prevScrollTop) <= (messageList.clientHeight + 2);
    if (!silent) { clearBlobUrls(); showLoadingSkeletons(messageList, 6); }

    try {
        const messages = await apiCall(`/channels/${channelId}/messages?limit=50`);
        if (channelId !== currentChannelId) return;
        if (silent && !messages.length) return;

        if (silent && messages.length > 0) {
            const latestMsg = messages[0], prevLastId = lastReadMessageIds[channelId];
            if (prevLastId && latestMsg.id !== prevLastId) {
                for (const msg of messages) {
                    try { if (BigInt(msg.id) <= BigInt(prevLastId)) break; } catch (e) { console.warn('[discord] BigInt compare:', e); if (msg.id === prevLastId) break; }
                    if (shouldNotify(channelId, msg)) sendNotification(msg, channelId);
                }
            }
        }

        if (messages.length > 0) {
            markChannelRead(channelId, messages[0].id);
            const channelEl = document.querySelector(`.channel-item[data-channel-id="${CSS.escape(channelId)}"]`);
            if (channelEl) channelEl.classList.remove('unread');
        }

        clearBlobUrls(); messageList.replaceChildren();
        if (!messages.length) { messageList.appendChild(placeholderEl('No messages here yet.')); return; }

        const decryptedMsgs = await Promise.all(messages.reverse().map(async msg => {
            const content = await e2eDecryptContent(channelId, msg.content);
            return { ...msg, content, _e2eDecrypted: content !== msg.content };
        }));

        decryptedMsgs.forEach(msg => {
            if (msg.author && isBlocked(settings.blockedUsers, msg.author.id)) return;
            const div = buildMessage(msg); messageList.appendChild(div); parseTwemoji(div); loadMediaInMessage(div);
        });

        if (!silent || atBottom) messageList.scrollTop = messageList.scrollHeight;
        else messageList.scrollTop = prevScrollTop + (messageList.scrollHeight - prevScrollHeight);
    } catch (err) {
        console.error('[discord]', new Date().toISOString(), 'loadMessages failed:', err);
        if (!silent) { clearBlobUrls(); messageList.replaceChildren(); messageList.appendChild(placeholderEl(`Failed to load messages: ${err.message}`, true)); }
    }
}

function buildMessage(msg) {
    const div = document.createElement('div');
    div.className = 'message' + (msg._e2eDecrypted ? ' encrypted' : '');
    div.dataset.msgId = msg.id;

    const displayName = msg.author?.global_name || msg.author?.username || 'Unknown';
    const actualUsername = msg.author?.username || '';

    const header = document.createElement('div'); header.className = 'message-header';
    const authorSpan = document.createElement('span'); authorSpan.className = 'author'; authorSpan.textContent = displayName;
    if (actualUsername) { const tooltip = document.createElement('span'); tooltip.className = 'author-tooltip'; tooltip.textContent = '@' + actualUsername; authorSpan.appendChild(tooltip); }
    if (msg.author) authorSpan.addEventListener('contextmenu', e => showContextMenu(e, 'user', msg.author.id, displayName));

    const date = new Date(msg.timestamp), isToday = date.toDateString() === new Date().toDateString();
    const timeStr = isToday ? `Today at ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : date.toLocaleString([], { month: 'numeric', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    const timeSpan = document.createElement('span'); timeSpan.className = 'timestamp'; timeSpan.textContent = timeStr;
    header.append(authorSpan, timeSpan);
    if (msg._e2eDecrypted) { const lockSpan = document.createElement('span'); lockSpan.className = 'msg-lock'; lockSpan.textContent = '\u{1F512}'; header.appendChild(lockSpan); }
    div.appendChild(header);

    const contentDiv = document.createElement('div'); contentDiv.className = 'content'; contentDiv.textContent = msg.content || '';
    div.appendChild(contentDiv);

    (msg.attachments || []).forEach((att, idx) => {
        const id = `att-${msg.id}-${idx}`, type = att.content_type || '', filename = att.filename || 'file';
        const url = type.startsWith('image/') ? (att.proxy_url || att.url) : att.url;
        let el;
        if (type.startsWith('image/')) {
            el = document.createElement('img'); el.id = id; el.className = 'attachment-preview'; el.alt = filename;
            el.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
        } else if (type.startsWith('video/')) {
            el = document.createElement('video'); el.id = id; el.controls = true; el.className = 'attachment-preview';
        } else {
            el = document.createElement('a'); el.id = id; el.className = 'attachment-link'; el.textContent = '\u{1F4CE} ' + filename;
        }
        el.dataset.proxyUrl = url; el.dataset.filename = filename;
        div.appendChild(el);
    });
    return div;
}

function loadMediaInMessage(div) {
    div.querySelectorAll('[data-proxy-url]').forEach(el => {
        const url = el.dataset.proxyUrl, filename = el.dataset.filename || url.split('/').pop().split('?')[0];
        if (el.tagName === 'IMG' || el.tagName === 'VIDEO') {
            el.src = url; if (el.tagName === 'IMG') el.alt = filename;
            proxyMedia(url).then(({ blobUrl }) => {
                activeBlobUrls.push(blobUrl);
                el.src = blobUrl;
                el.onload = () => { /* cleanup handled — blob tracked in activeBlobUrls */ };
                el.onerror = () => { URL.revokeObjectURL(blobUrl); };
                addDownloadLink(el, blobUrl, filename);
            })
                .catch((err) => { console.warn('[discord] proxyMedia failed:', err); const link = document.createElement('a'); link.href = url; link.target = '_blank'; link.className = 'download-link'; link.textContent = 'Open'; el.after(link); });
        } else {
            proxyMedia(url).then(({ blobUrl }) => { activeBlobUrls.push(blobUrl); el.href = blobUrl; el.download = filename; el.target = ''; })
                .catch((err) => { console.warn('[discord] proxyMedia failed:', err); el.href = url; el.target = '_blank'; });
        }
    });
}

// ── Send Message ──────────────────────────────────────────
sendButton.addEventListener('click', sendMessage);
messageInput.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } });

async function sendMessage() {
    if (isSending) return;
    let content = messageInput.value.trim();
    const hasFiles = fileInput.files.length > 0;
    if (!content && !hasFiles) return;
    if (!currentChannelId) return;
    isSending = true;

    // Validate file upload before sending
    if (hasFiles) {
        const file = fileInput.files[0];
        const validation = InputValidator.validateFileUpload(file);
        if (!validation.valid) {
            showToast(validation.reason, 'warning');
            return;
        }
    }

    messageInput.disabled = true; sendButton.disabled = true;
    try {
        if (content && e2eKeys[currentChannelId]) content = await e2eEncrypt(currentChannelId, content);
        let body, extraHeaders = {};
        if (hasFiles) {
            const fd = new FormData();
            fd.append('file[0]', fileInput.files[0]);
            fd.append('payload_json', JSON.stringify({ content }));
            body = fd;
        }
        else { body = JSON.stringify({ content }); extraHeaders['Content-Type'] = 'application/json'; }
        const timeoutMs = hasFiles ? UPLOAD_TIMEOUT_MS : FETCH_TIMEOUT_MS;
        const res = await fetch(`${getApiBase()}/channels/${currentChannelId}/messages`, { method: 'POST', headers: { 'Authorization': userToken, ...extraHeaders }, body, signal: AbortSignal.timeout(timeoutMs) });
        if (!res.ok) throw new Error(`Status ${res.status}`);
        messageInput.value = ''; fileInput.value = ''; fileBtn.classList.remove('active'); messageInput.placeholder = 'Message...';
        if (!gatewayReady) loadMessages(currentChannelId);
    } catch (err) {
        console.error('[discord]', new Date().toISOString(), 'sendMessage failed:', err);
        showToast(`Failed to send: ${err.message}`);
        messageInput.focus();
    }
    finally { isSending = false; messageInput.disabled = false; sendButton.disabled = false; }
}

// ── Proxy / Media ─────────────────────────────────────────
async function proxyMedia(url) {
    let res;
    try {
        res = await fetch(`${clientConfig.proxyBase}/image`, { headers: { 'mediaurl': url }, mode: 'cors', signal: AbortSignal.timeout(MEDIA_TIMEOUT_MS) });
    } catch (err) {
        console.error('[discord]', new Date().toISOString(), 'proxyMedia failed:', err);
        throw new Error('Image load failed. Check your proxy URL and network connection.');
    }
    if (!res.ok) throw new Error(res.status);
    const blob = await res.blob(), blobUrl = URL.createObjectURL(blob);
    return { blobUrl, blob };
}

function addDownloadLink(el, blobUrl, filename) {
    const a = document.createElement('a'); a.href = blobUrl; a.download = filename;
    a.className = 'download-link'; a.textContent = 'Download'; el.after(a);
}

function clearBlobUrls() { activeBlobUrls.forEach(u => URL.revokeObjectURL(u)); activeBlobUrls = []; }

// ── Add DM Modal ──────────────────────────────────────────
function openAddDmModal() { addDmUserInput.value = ''; addDmModal.style.display = 'flex'; addDmUserInput.focus(); }
function closeAddDmModal() { addDmModal.style.display = 'none'; }
document.getElementById('add-dm-cancel-btn').addEventListener('click', closeAddDmModal);
document.getElementById('add-dm-submit').addEventListener('click', addDm);
addDmUserInput.addEventListener('keydown', e => { if (e.key === 'Enter') addDm(); });

async function addDm() {
    const userId = addDmUserInput.value.trim();
    if (!userId) return;
    if (!isValidSnowflake(userId)) { showToast('Please enter a valid user ID (numeric, 17-20 digits).', 'warning'); return; }
    try {
        const channel = await apiCall('/users/@me/channels', { method: 'POST', body: JSON.stringify({ recipients: [userId] }) });
        closeAddDmModal(); currentView = 'dm'; await loadDMs();
        const name = channel.recipients?.map(r => r.global_name || r.username).join(', ') || 'DM';
        chatTitle.textContent = name; loadMessages(channel.id);
    } catch (err) {
        console.error('[discord]', new Date().toISOString(), 'addDm failed:', err);
        showToast(`Failed to open DM: ${err.message}`);
    }
}

// ── PWA: Inline Manifest ─────────────────────────────────
const pwaIconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="96" fill="#5865f2"/><path d="M346 218c-14-7-29-12-45-15l-5 11c-17-3-34-3-51 0l-5-11c-16 3-31 8-45 15-29 42-36 84-32 124 20 15 39 24 58 30l7-10-2-1c-11-5-21-12-31-19l4-3c51 24 107 24 157 0l4 3c-10 7-20 14-31 19l-2 1 7 10c19-6 39-15 58-30 5-47-8-88-32-124z" fill="#fff"/><circle cx="215" cy="295" r="25" fill="#5865f2"/><circle cx="297" cy="295" r="25" fill="#5865f2"/></svg>`;
const pwaIconUrl = 'data:image/svg+xml;base64,' + btoa(pwaIconSvg);
const manifest = { name: 'Local Discord Client', short_name: 'Discord', description: 'A static Discord client that runs through a CORS proxy.', start_url: './', display: 'standalone', background_color: '#36393f', theme_color: '#36393f', icons: [{ src: pwaIconUrl, sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }] };
const manifestBlob = new Blob([JSON.stringify(manifest)], { type: 'application/manifest+json' });
const manifestUrl = URL.createObjectURL(manifestBlob);
const manifestLink = document.createElement('link'); manifestLink.rel = 'manifest'; manifestLink.href = manifestUrl; document.head.appendChild(manifestLink);
const appleIcon = document.createElement('link'); appleIcon.rel = 'apple-touch-icon'; appleIcon.href = pwaIconUrl; document.head.appendChild(appleIcon);

// ── PWA: Inline Service Worker ────────────────────────────
const swCode = `
const CACHE_NAME = 'discord-client-v2';
const SHELL_URLS = [self.registration.scope];
self.addEventListener('install', event => { event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL_URLS))); self.skipWaiting(); });
self.addEventListener('activate', event => { event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))); self.clients.claim(); });
self.addEventListener('fetch', event => {
    const url = new URL(event.request.url);
    if (event.request.mode === 'navigate') { event.respondWith(caches.match(event.request).then(cached => { const fp = fetch(event.request).then(r => { if (r.ok) caches.open(CACHE_NAME).then(c => c.put(event.request, r)); return r.clone(); }).catch(() => cached); return cached || fp; })); return; }
    if (url.pathname === '/image') { event.respondWith(caches.open('discord-media-v1').then(cache => cache.match(event.request).then(cached => { if (cached) return cached; return fetch(event.request).then(r => { if (r.ok) cache.put(event.request, r.clone()); return r; }); }))); return; }
});`;
if ('serviceWorker' in navigator) { const swBlob = new Blob([swCode], { type: 'application/javascript' }); const swUrl = URL.createObjectURL(swBlob); navigator.serviceWorker.register(swUrl, { scope: './' }).catch((e) => { console.warn('[discord] SW registration failed:', e); }); }

// ── Cleanup on unload ─────────────────────────────────────
window.addEventListener('beforeunload', () => {
    clearBlobUrls();
    clearTimeout(refreshTimeout);
    clearInterval(gatewayHeartbeat);
    if (gateway) { try { gateway.close(); } catch (_) {} }
    if (browserWs) { try { browserWs.close(); } catch (_) {} }
});

// ── Start ─────────────────────────────────────────────────
settingRefresh.value = settings.refreshInterval;
init();
