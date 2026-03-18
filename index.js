// ══════════════════════════════════════════════════════════
// Static Discord Client — index.js
// ══════════════════════════════════════════════════════════

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
    return (str || '').replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
    }[c]));
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
    closeBtn.addEventListener('click', (e) => { e.stopPropagation(); overlay.remove(); });
    overlay.addEventListener('click', () => overlay.remove());
    img.addEventListener('click', (e) => e.stopPropagation());
    overlay.append(img, closeBtn);
    document.body.appendChild(overlay);
    document.addEventListener('keydown', function handler(e) {
        if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', handler); }
    });
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
    try {
        const u = new URL(str);
        return u.protocol === 'https:';
    } catch { return false; }
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

function loadClientConfig() {
    try {
        const saved = JSON.parse(localStorage.getItem('discord_client_config'));
        if (saved && typeof saved === 'object') {
            const cfg = { ...DEFAULT_CONFIG, ...saved };
            if (!isValidHttpsUrl(cfg.proxyBase)) return null;
            if (!VALID_NOTIFY_MODES.includes(cfg.notifyMode)) cfg.notifyMode = 'dm_mentions';
            return cfg;
        }
    } catch (_) {}
    return null;
}

function saveClientConfig(cfg) {
    localStorage.setItem('discord_client_config', JSON.stringify(cfg));
    clientConfig = cfg;
}

let clientConfig = loadClientConfig();

function getApiBase() {
    return clientConfig.proxyBase + '/https://discord.com/api/v9';
}

// ── State ─────────────────────────────────────────────────
let userToken        = '';
let currentUserId    = '';
let currentChannelId = null;
let refreshTimeout   = null;
let isConnecting     = false;
let currentView      = 'dm';
let activeBlobUrls   = [];
let lastReadMessageIds = {};
let currentGuildChannels = {};
let mfaTicket        = '';
let mfaIsBackup      = false;
let qrWebSocket      = null;
let qrKeyPair        = null;

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
    } catch (_) {}
}

function saveReadState() {
    localStorage.setItem('discord_read_state', JSON.stringify(lastReadMessageIds));
}

function loadE2EKeys() {
    try {
        const saved = JSON.parse(localStorage.getItem('discord_e2e_keys'));
        if (saved && typeof saved === 'object') e2eKeys = saved;
    } catch (_) {}
}

function saveE2EKeys() {
    localStorage.setItem('discord_e2e_keys', JSON.stringify(e2eKeys));
}

loadReadState();
loadE2EKeys();

// ── DOM Refs ──────────────────────────────────────────────
const setupScreen    = document.getElementById('setup-screen');
const loginScreen    = document.getElementById('login-screen');
const appScreen      = document.getElementById('app');
const tokenInput     = document.getElementById('token-input');
const loginButton    = document.getElementById('login-button');
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
    blockedChannels: []
};

function loadSettings() {
    try {
        const saved = JSON.parse(localStorage.getItem('discord_settings'));
        if (saved && typeof saved === 'object') settings = { ...settings, ...saved };
    } catch (_) {}
}
loadSettings();

function saveSettings() {
    localStorage.setItem('discord_settings', JSON.stringify(settings));
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

// ── Setup Screen ──────────────────────────────────────────
document.getElementById('setup-save-btn').addEventListener('click', () => {
    const proxyBase = document.getElementById('setup-proxy-url').value.trim().replace(/\/+$/, '');
    const notifyMode = document.getElementById('setup-notify-mode').value;
    if (!proxyBase) { showToast('Proxy URL is required.', 'warning'); return; }
    if (!isValidHttpsUrl(proxyBase)) { showToast('Proxy URL must be a valid HTTPS URL.', 'warning'); return; }
    saveClientConfig({ proxyBase, notifyMode });
    setupScreen.style.display = 'none';
    showLoginScreen();
});

// ── Init Flow ─────────────────────────────────────────────
function init() {
    // Check for token injected via URL hash by playwright-login.js
    // Hash fragment is never sent to any server — stays client-side only
    const hashToken = getHashParam('pl_token');
    if (hashToken) {
        // Clear hash immediately so token isn't visible in address bar
        history.replaceState(null, '', location.pathname + location.search);
        // Ensure config exists before connecting
        if (!clientConfig) {
            saveClientConfig({ ...DEFAULT_CONFIG });
        }
        showLoginScreen();
        connect(hashToken);
        return;
    }
    if (!clientConfig) { setupScreen.style.display = 'flex'; }
    else { showLoginScreen(); }
}

function getHashParam(key) {
    const hash = location.hash.slice(1); // remove leading #
    const params = new URLSearchParams(hash);
    return params.get(key) || null;
}

function showLoginScreen() {
    const savedToken = sessionStorage.getItem('discord_user_token');
    if (savedToken) {
        tokenInput.value = savedToken;
        loginScreen.style.display = 'flex';
        connect(savedToken);
    } else {
        loginScreen.style.display = 'flex';
    }
}

// ── Login Tabs ────────────────────────────────────────────
document.querySelectorAll('.login-tab').forEach(tab => {
    tab.addEventListener('click', () => {
        document.querySelectorAll('.login-tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.login-panel').forEach(p => p.classList.remove('active'));
        tab.classList.add('active');
        document.getElementById('tab-' + tab.dataset.tab).classList.add('active');
        showLoginError('');
        resetMfaState();
        cleanupQrLogin();
        if (tab.dataset.tab === 'qr') startQrLogin();
        if (tab.dataset.tab === 'browser') initBrowserStream();
    });
});

// ── Browser Stream Login ─────────────────────────────────
// Mirrors list — replace with your Cloudflare Tunnel URLs
const PLAYWRIGHT_MIRRORS = [
    // 'https://your-tunnel-id.trycloudflare.com',
];

let browserWs = null;
let browserStreamActive = false;

async function findActiveMirror() {
    for (const url of PLAYWRIGHT_MIRRORS) {
        try {
            const res = await fetch(url + '/status', { signal: AbortSignal.timeout(3000) });
            if (res.ok) {
                const data = await res.json();
                if (data.ok && data.discord) return url;
            }
        } catch (_) {}
    }
    return null;
}

function initBrowserStream() {
    const status = document.getElementById('browser-status');
    const btn = document.getElementById('browser-connect-btn');
    if (browserStreamActive) return;
    status.textContent = 'Add tunnel URLs to PLAYWRIGHT_MIRRORS in index.js';
    status.className = 'browser-login-status';
    btn.style.display = '';
    btn.onclick = startBrowserLogin;
}

async function startBrowserLogin() {
    const status = document.getElementById('browser-status');
    const canvas = document.getElementById('browser-canvas');
    const btn = document.getElementById('browser-connect-btn');
    const ctx = canvas.getContext('2d');

    btn.disabled = true;
    status.textContent = 'Checking mirrors...';
    status.className = 'browser-login-status';

    const mirror = await findActiveMirror();
    if (!mirror) {
        status.textContent = 'No mirrors available. Add tunnel URLs to PLAYWRIGHT_MIRRORS.';
        status.className = 'browser-login-status error';
        btn.disabled = false;
        return;
    }

    status.textContent = 'Connecting to ' + new URL(mirror).hostname + '...';
    btn.style.display = 'none';
    canvas.style.display = 'block';

    const wsUrl = mirror.replace(/^http/, 'ws') + '/stream?type=discord';
    browserWs = new WebSocket(wsUrl);
    browserStreamActive = true;

    browserWs.onopen = () => {
        status.textContent = 'Connected — log in below';
        status.className = 'browser-login-status success';
    };

    browserWs.onmessage = (evt) => {
        let msg;
        try { msg = JSON.parse(evt.data); } catch (_) { return; }

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
        } else if (msg.type === 'token') {
            status.textContent = 'Login successful! Connecting...';
            status.className = 'browser-login-status success';
            cleanupBrowserStream();
            connect(msg.token);
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
            btn.style.display = '';
            btn.disabled = false;
        }
    };

    browserWs.onerror = () => {};

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

function cleanupBrowserStream() {
    browserStreamActive = false;
    if (browserWs) {
        try { browserWs.close(); } catch (_) {}
        browserWs = null;
    }
}

function showLoginError(msg) {
    loginError.textContent = msg;
    loginError.style.display = msg ? 'block' : 'none';
}

function resetMfaState() {
    mfaTicket = '';
    mfaIsBackup = false;
    document.getElementById('mfa-section').classList.remove('active');
    document.getElementById('credential-fields').classList.remove('hidden');
    document.getElementById('mfa-code').value = '';
    document.getElementById('mfa-toggle-backup').textContent = 'Use a backup code instead';
}

// ── Credential Login ──────────────────────────────────────
const credLoginBtn = document.getElementById('cred-login-button');
const credEmail    = document.getElementById('cred-email');
const credPassword = document.getElementById('cred-password');
const mfaCodeInput = document.getElementById('mfa-code');
const mfaSubmitBtn = document.getElementById('mfa-submit-button');
const mfaToggle    = document.getElementById('mfa-toggle-backup');

credLoginBtn.addEventListener('click', () => loginWithCredentials());
credPassword.addEventListener('keydown', e => { if (e.key === 'Enter') loginWithCredentials(); });

async function loginWithCredentials() {
    const email = credEmail.value.trim();
    const password = credPassword.value;
    if (!email || !password) return;
    credLoginBtn.disabled = true;
    credLoginBtn.textContent = 'Logging in...';
    showLoginError('');
    try {
        const res = await fetch(`${getApiBase()}/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ login: email, password })
        });
        const data = await res.json();
        if (data.token) { connect(data.token); return; }
        if (data.mfa || data.ticket) {
            mfaTicket = data.ticket;
            document.getElementById('credential-fields').classList.add('hidden');
            document.getElementById('mfa-section').classList.add('active');
            mfaCodeInput.focus();
            return;
        }
        if (data.captcha_key) { showLoginError('CAPTCHA required. Use QR code or token login instead.'); return; }
        showLoginError(data.message || `Login failed (${res.status})`);
    } catch (err) {
        showLoginError(`Login failed: ${err.message}`);
    } finally {
        credLoginBtn.disabled = false;
        credLoginBtn.textContent = 'Log In';
    }
}

// ── QR Code Remote Auth ───────────────────────────────────
const qrStatus   = document.getElementById('qr-status');
const qrCanvas   = document.getElementById('qr-canvas');
const qrUserInfo = document.getElementById('qr-user-info');

function cleanupQrLogin() {
    if (qrWebSocket) { qrWebSocket.close(); qrWebSocket = null; }
    qrKeyPair = null;
}

let qrExpiryTimeout = null;
let qrExpiryInterval = null;

async function startQrLogin() {
    cleanupQrLogin();
    clearTimeout(qrExpiryTimeout);
    clearInterval(qrExpiryInterval);
    qrStatus.className = '';
    qrStatus.textContent = 'Generating...';
    qrCanvas.style.display = 'none';
    qrUserInfo.classList.remove('active');
    try {
        qrKeyPair = await crypto.subtle.generateKey(
            { name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
            true, ['encrypt', 'decrypt']
        );
        const pubDer = await crypto.subtle.exportKey('spki', qrKeyPair.publicKey);
        const pubB64 = btoa(String.fromCharCode(...new Uint8Array(pubDer)));
        qrStatus.textContent = 'Connecting...';
        const ws = new WebSocket('wss://remote-auth-gateway.discord.gg/?v=2');
        qrWebSocket = ws;
        let hbInterval = null;
        ws.onclose = () => {
            clearInterval(hbInterval);
            clearTimeout(qrExpiryTimeout);
            clearInterval(qrExpiryInterval);
            if (qrWebSocket === ws) {
                qrStatus.textContent = 'Disconnected.';
                qrStatus.className = 'error';
                qrCanvas.style.display = 'none';
                // Add clickable retry
                const retryBtn = document.createElement('span');
                retryBtn.textContent = ' Click to retry';
                retryBtn.style.cssText = 'cursor:pointer;text-decoration:underline;color:#5865f2';
                retryBtn.addEventListener('click', () => startQrLogin());
                qrStatus.appendChild(retryBtn);
            }
        };
        ws.onerror = () => {
            qrStatus.textContent = 'Connection failed.';
            qrStatus.className = 'error';
            const retryBtn = document.createElement('span');
            retryBtn.textContent = ' Click to retry';
            retryBtn.style.cssText = 'cursor:pointer;text-decoration:underline;color:#5865f2';
            retryBtn.addEventListener('click', () => startQrLogin());
            qrStatus.appendChild(retryBtn);
        };
        ws.onmessage = async (event) => {
            const msg = JSON.parse(event.data);
            switch (msg.op) {
                case 'hello':
                    hbInterval = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ op: 'heartbeat' })); }, msg.heartbeat_interval);
                    ws.send(JSON.stringify({ op: 'init', encoded_public_key: pubB64 }));
                    break;
                case 'nonce_proof':
                    try {
                        const encNonce = Uint8Array.from(atob(msg.encrypted_nonce), c => c.charCodeAt(0));
                        const dec = await crypto.subtle.decrypt({ name: 'RSA-OAEP' }, qrKeyPair.privateKey, encNonce);
                        const hash = await crypto.subtle.digest('SHA-256', dec);
                        const proof = btoa(String.fromCharCode(...new Uint8Array(hash))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
                        ws.send(JSON.stringify({ op: 'nonce_proof', proof }));
                    } catch (e) { qrStatus.textContent = 'Crypto error: ' + e.message; qrStatus.className = 'error'; }
                    break;
                case 'pending_remote_init': {
                    qrCanvas.style.display = 'block';
                    renderQrCode('https://discord.com/ra/' + msg.fingerprint);
                    // Start 2-minute expiry countdown
                    let secondsLeft = 120;
                    qrStatus.textContent = `Scan with Discord mobile app (${secondsLeft}s)`;
                    qrExpiryInterval = setInterval(() => {
                        secondsLeft--;
                        if (secondsLeft > 0) {
                            qrStatus.textContent = `Scan with Discord mobile app (${secondsLeft}s)`;
                        }
                    }, 1000);
                    qrExpiryTimeout = setTimeout(() => {
                        clearInterval(qrExpiryInterval);
                        if (qrWebSocket === ws) {
                            ws.close();
                            qrCanvas.style.display = 'none';
                            qrStatus.textContent = 'QR code expired.';
                            qrStatus.className = 'error';
                            const retryBtn = document.createElement('span');
                            retryBtn.textContent = ' Click to refresh';
                            retryBtn.style.cssText = 'cursor:pointer;text-decoration:underline;color:#5865f2';
                            retryBtn.addEventListener('click', () => startQrLogin());
                            qrStatus.appendChild(retryBtn);
                        }
                    }, 120000);
                    break;
                }
                case 'pending_ticket': {
                    clearInterval(qrExpiryInterval);
                    clearTimeout(qrExpiryTimeout);
                    try {
                        const encP = Uint8Array.from(atob(msg.encrypted_user_payload), c => c.charCodeAt(0));
                        const decP = await crypto.subtle.decrypt({ name: 'RSA-OAEP' }, qrKeyPair.privateKey, encP);
                        const parts = new TextDecoder().decode(decP).split(':');
                        qrCanvas.style.display = 'none';
                        qrUserInfo.classList.add('active');
                        document.getElementById('qr-username').textContent = parts.slice(3).join(':');
                        if (parts[2]) document.getElementById('qr-avatar').src = `https://cdn.discordapp.com/avatars/${parts[0]}/${parts[2]}.png?size=128`;
                        qrStatus.textContent = 'Scanned! Confirm on your phone...';
                        qrStatus.className = 'success';
                    } catch (_) { qrStatus.textContent = 'Waiting for confirmation...'; }
                    break;
                }
                case 'pending_login': {
                    qrStatus.textContent = 'Login successful! Loading...';
                    try {
                        const res = await fetch(`${getApiBase()}/users/@me/remote-auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket: msg.ticket }) });
                        const data = await res.json();
                        if (data.encrypted_token) {
                            const encT = Uint8Array.from(atob(data.encrypted_token), c => c.charCodeAt(0));
                            const token = new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'RSA-OAEP' }, qrKeyPair.privateKey, encT));
                            cleanupQrLogin(); connect(token);
                        } else { throw new Error(data.message || 'No token received'); }
                    } catch (e) { qrStatus.textContent = 'Login failed: ' + e.message; qrStatus.className = 'error'; }
                    break;
                }
                case 'cancel':
                    clearInterval(qrExpiryInterval);
                    clearTimeout(qrExpiryTimeout);
                    qrStatus.textContent = 'Login cancelled.'; qrStatus.className = 'error';
                    qrCanvas.style.display = 'none'; qrUserInfo.classList.remove('active');
                    const retryBtn = document.createElement('span');
                    retryBtn.textContent = ' Click to retry';
                    retryBtn.style.cssText = 'cursor:pointer;text-decoration:underline;color:#5865f2';
                    retryBtn.addEventListener('click', () => startQrLogin());
                    qrStatus.appendChild(retryBtn);
                    break;
                case 'heartbeat_ack': break;
            }
        };
    } catch (err) { qrStatus.textContent = 'Failed: ' + err.message; qrStatus.className = 'error'; }
}

// ── QR Code Generator ─────────────────────────────────────
function renderQrCode(text) {
    const canvas = qrCanvas, ctx = canvas.getContext('2d');
    const modules = generateQR(text), size = modules.length, scale = Math.floor(200 / size);
    canvas.width = size * scale; canvas.height = size * scale;
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#000000';
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) { if (modules[y][x]) ctx.fillRect(x * scale, y * scale, scale, scale); }
}

function generateQR(data) {
    const dataBytes = new TextEncoder().encode(data), dataLen = dataBytes.length;
    const capacityL = [0,17,32,53,78,106,134,154,192,230,271,321,367,425,458,520,586,644,718,792,858,929,1003,1091,1171,1273,1367,1465,1528,1628,1732,1840,1952,2068,2188,2303,2431,2563,2699,2809,2953];
    let version = 1;
    for (let v = 1; v <= 40; v++) { if (capacityL[v] >= dataLen + 3) { version = v; break; } }
    const size = version * 4 + 17, totalCW = getDataCodewords(version), eccCW = getEccCodewords(version), dataCW = totalCW - eccCW;
    const bits = [];
    pushBits(bits, 0b0100, 4); pushBits(bits, dataLen, version <= 9 ? 8 : 16);
    for (const b of dataBytes) pushBits(bits, b, 8);
    const maxBits = dataCW * 8;
    pushBits(bits, 0, Math.min(4, maxBits - bits.length));
    while (bits.length % 8 !== 0) bits.push(0);
    let pad = 0; while (bits.length < maxBits) { pushBits(bits, pad === 0 ? 0xEC : 0x11, 8); pad ^= 1; }
    const dataCodewords = [];
    for (let i = 0; i < bits.length; i += 8) { let byte = 0; for (let j = 0; j < 8; j++) byte = (byte << 1) | (bits[i + j] || 0); dataCodewords.push(byte); }
    const ecBytes = rsEncode(dataCodewords, eccCW), allBytes = [...dataCodewords, ...ecBytes];
    const grid = Array.from({ length: size }, () => Array(size).fill(null)), reserved = Array.from({ length: size }, () => Array(size).fill(false));
    placeFinder(grid, reserved, 0, 0); placeFinder(grid, reserved, size - 7, 0); placeFinder(grid, reserved, 0, size - 7);
    for (let i = 8; i < size - 8; i++) { grid[6][i] = i % 2 === 0 ? 1 : 0; grid[i][6] = i % 2 === 0 ? 1 : 0; reserved[6][i] = true; reserved[i][6] = true; }
    if (version >= 2) { const positions = getAlignmentPositions(version); for (const r of positions) for (const c of positions) { if (reserved[r]?.[c]) continue; if ((r < 9 && c < 9) || (r < 9 && c >= size - 8) || (r >= size - 8 && c < 9)) continue; placeAlignment(grid, reserved, r, c); } }
    for (let i = 0; i < 8; i++) { reserved[8][i] = true; reserved[i][8] = true; reserved[8][size - 1 - i] = true; reserved[size - 1 - i][8] = true; }
    reserved[8][8] = true; grid[size - 8][8] = 1; reserved[size - 8][8] = true;
    if (version >= 7) { for (let i = 0; i < 6; i++) for (let j = 0; j < 3; j++) { reserved[i][size - 11 + j] = true; reserved[size - 11 + j][i] = true; } }
    let bitIdx = 0; const allBits = []; for (const byte of allBytes) for (let b = 7; b >= 0; b--) allBits.push((byte >> b) & 1);
    let right = size - 1, upward = true;
    while (right >= 0) { if (right === 6) right--; for (let row = 0; row < size; row++) { const y = upward ? size - 1 - row : row; for (const dx of [0, -1]) { const x = right + dx; if (x < 0 || x >= size || reserved[y][x]) continue; grid[y][x] = bitIdx < allBits.length ? allBits[bitIdx++] : 0; } } upward = !upward; right -= 2; }
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) { if (!reserved[y][x] && (y + x) % 2 === 0) grid[y][x] ^= 1; }
    const formatBits = getFormatBits(0);
    for (let i = 0; i < 15; i++) { const bit = (formatBits >> (14 - i)) & 1; if (i < 6) grid[8][i] = bit; else if (i === 6) grid[8][7] = bit; else if (i === 7) grid[8][8] = bit; else if (i === 8) grid[7][8] = bit; else grid[14 - i][8] = bit; if (i < 8) grid[size - 1 - i][8] = bit; else grid[8][size - 15 + i] = bit; }
    if (version >= 7) { const vInfo = getVersionBits(version); for (let i = 0; i < 18; i++) { const bit = (vInfo >> i) & 1; const r = Math.floor(i / 3), c = i % 3; grid[r][size - 11 + c] = bit; grid[size - 11 + c][r] = bit; } }
    return grid;
}
function pushBits(arr, value, len) { for (let i = len - 1; i >= 0; i--) arr.push((value >> i) & 1); }
function placeFinder(grid, reserved, row, col) { for (let r = -1; r <= 7; r++) for (let c = -1; c <= 7; c++) { const y = row + r, x = col + c; if (y < 0 || x < 0 || y >= grid.length || x >= grid.length) continue; const inOuter = r === 0 || r === 6 || c === 0 || c === 6; const inInner = r >= 2 && r <= 4 && c >= 2 && c <= 4; grid[y][x] = (inOuter || inInner) && r >= 0 && r <= 6 && c >= 0 && c <= 6 ? 1 : 0; reserved[y][x] = true; } }
function placeAlignment(grid, reserved, row, col) { for (let r = -2; r <= 2; r++) for (let c = -2; c <= 2; c++) { const y = row + r, x = col + c; if (y < 0 || x < 0 || y >= grid.length || x >= grid.length) continue; grid[y][x] = (Math.abs(r) === 2 || Math.abs(c) === 2 || (r === 0 && c === 0)) ? 1 : 0; reserved[y][x] = true; } }
function getAlignmentPositions(version) { if (version === 1) return []; const intervals = [0,0,0,0,0,0,0,16,18,20,22,24,26,28,20,22,24,24,26,28,28,22,24,24,26,26,28,28,24,24,26,26,26,28,28,24,26,26,26,28,28]; const step = intervals[version] || 28; const last = version * 4 + 10; const positions = [6]; let pos = last; while (pos > 6 + step) { positions.unshift(pos); pos -= step; } if (positions[0] !== 6) positions.unshift(6); if (positions[positions.length - 1] !== last) positions.push(last); return [...new Set(positions)].sort((a, b) => a - b); }
function getDataCodewords(version) { const total = [0,26,44,70,100,134,172,196,242,292,346,404,466,532,581,655,733,815,901,991,1085,1156,1258,1364,1474,1588,1706,1828,1921,2051,2185,2323,2465,2611,2761,2876,3034,3196,3362,3532,3706]; return total[version] || 0; }
function getEccCodewords(version) { const ecc = [0,7,10,15,20,26,36,40,48,60,72,80,92,104,112,128,144,160,176,198,216,224,252,270,300,312,336,360,390,420,450,480,510,540,570,570,600,630,660,720,750]; return ecc[version] || 0; }
function rsEncode(data, eccCount) { const gfExp = new Uint8Array(512), gfLog = new Uint8Array(256); let x = 1; for (let i = 0; i < 255; i++) { gfExp[i] = x; gfLog[x] = i; x = (x << 1) ^ (x >= 128 ? 0x11d : 0); } for (let i = 255; i < 512; i++) gfExp[i] = gfExp[i - 255]; const gfMul = (a, b) => a === 0 || b === 0 ? 0 : gfExp[gfLog[a] + gfLog[b]]; let gen = [1]; for (let i = 0; i < eccCount; i++) { const next = new Array(gen.length + 1).fill(0); for (let j = 0; j < gen.length; j++) { next[j] ^= gen[j]; next[j + 1] ^= gfMul(gen[j], gfExp[i]); } gen = next; } const result = new Array(eccCount).fill(0); for (const byte of data) { const lead = byte ^ result[0]; for (let i = 0; i < eccCount - 1; i++) result[i] = result[i + 1] ^ gfMul(lead, gen[i + 1]); result[eccCount - 1] = gfMul(lead, gen[eccCount]); } return result; }
function getFormatBits(mask) { const data = (0b01 << 3) | mask; let bits = data << 10, gen = 0b10100110111; for (let i = 14; i >= 10; i--) { if (bits & (1 << i)) bits ^= gen << (i - 10); } return ((data << 10) | bits) ^ 0b101010000010010; }
function getVersionBits(version) { let bits = version << 12, gen = 0b1111100100101; for (let i = 17; i >= 12; i--) { if (bits & (1 << i)) bits ^= gen << (i - 12); } return (version << 12) | bits; }

// ── MFA ───────────────────────────────────────────────────
mfaToggle.addEventListener('click', () => {
    mfaIsBackup = !mfaIsBackup;
    mfaToggle.textContent = mfaIsBackup ? 'Use TOTP code instead' : 'Use a backup code instead';
    mfaCodeInput.placeholder = mfaIsBackup ? 'Backup code (xxxx-xxxx)' : '6-digit code';
    mfaCodeInput.value = ''; mfaCodeInput.focus();
});
mfaSubmitBtn.addEventListener('click', () => submitMFA());
mfaCodeInput.addEventListener('keydown', e => { if (e.key === 'Enter') submitMFA(); });

async function submitMFA() {
    const code = mfaCodeInput.value.trim();
    if (!code || !mfaTicket) return;
    mfaSubmitBtn.disabled = true; mfaSubmitBtn.textContent = 'Verifying...'; showLoginError('');
    const endpoint = mfaIsBackup ? '/auth/mfa/backup-codes/verify' : '/auth/mfa/totp';
    try {
        const res = await fetch(`${getApiBase()}${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, ticket: mfaTicket }) });
        const data = await res.json();
        if (data.token) { resetMfaState(); connect(data.token); return; }
        showLoginError(data.message || `MFA failed (${res.status})`);
    } catch (err) { showLoginError(`MFA failed: ${err.message}`); }
    finally { mfaSubmitBtn.disabled = false; mfaSubmitBtn.textContent = 'Verify'; }
}

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

function openSettings() {
    settingProxyUrl.value = clientConfig.proxyBase;
    settingNotifyMode.value = clientConfig.notifyMode || 'dm_mentions';
    settingRefresh.value = settings.refreshInterval;
    renderBlockedList('blocked-users-list', settings.blockedUsers, 'blockedUsers');
    renderBlockedList('blocked-servers-list', settings.blockedServers, 'blockedServers');
    renderBlockedList('blocked-channels-list', settings.blockedChannels, 'blockedChannels');
    settingsModal.style.display = 'flex';
}

function closeSettings() {
    const newProxy = settingProxyUrl.value.trim().replace(/\/+$/, '');
    const newNotify = settingNotifyMode.value;
    if (newProxy && isValidHttpsUrl(newProxy)) {
        saveClientConfig({ ...clientConfig, proxyBase: newProxy, notifyMode: newNotify });
    } else {
        saveClientConfig({ ...clientConfig, notifyMode: newNotify });
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
    loginButton.textContent = 'Connecting...';
    loginButton.disabled = true;
    showLoginError('');
    try {
        const res = await fetch(`${getApiBase()}/users/@me`, { headers: { 'Authorization': userToken } });
        if (res.status === 401) throw new Error('Invalid token.');
        if (!res.ok) throw new Error(`Server responded with ${res.status}.`);
        const userData = await res.json();
        currentUserId = userData.id;
        sessionStorage.setItem('discord_user_token', userToken);
        loginScreen.style.display = 'none';
        appScreen.style.display = 'flex';
        if (clientConfig.notifyMode !== 'off' && 'Notification' in window && Notification.permission === 'default') Notification.requestPermission();
        loadGuilds(); loadDMs(); updateE2EButton(); connectGateway(); startAutoRefresh();
    } catch (err) {
        showLoginError(`Connection failed: ${err.message}`);
        loginButton.textContent = 'Connect'; loginButton.disabled = false;
        sessionStorage.removeItem('discord_user_token'); tokenInput.value = '';
    } finally { isConnecting = false; }
}

loginButton.addEventListener('click', () => connect(tokenInput.value.trim()));
tokenInput.addEventListener('keydown', e => { if (e.key === 'Enter') connect(tokenInput.value.trim()); });

// ── API ───────────────────────────────────────────────────
async function apiCall(endpoint, options = {}) {
    const headers = { 'Authorization': userToken, 'Content-Type': 'application/json', ...options.headers };
    let res;
    try {
        res = await fetch(`${getApiBase()}${endpoint}`, { ...options, headers, mode: 'cors' });
    } catch (err) {
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
    setGatewayStatus('reconnecting', 'Connecting...');
    const url = gatewayResumeUrl || 'wss://gateway.discord.gg/?v=9&encoding=json';
    const ws = new WebSocket(url);
    gateway = ws;

    ws.onopen = () => { gatewayReconnectDelay = 1000; };
    ws.onclose = () => {
        clearInterval(gatewayHeartbeat); gatewayHeartbeat = null; gatewayReady = false;
        setGatewayStatus('disconnected', 'Disconnected \u2014 using polling');
        if (gateway === ws && userToken) {
            startAutoRefresh();
            setTimeout(() => { if (userToken) connectGateway(); }, gatewayReconnectDelay);
            gatewayReconnectDelay = Math.min(gatewayReconnectDelay * 2, 30000);
        }
    };
    ws.onerror = () => {};
    ws.onmessage = (event) => {
        let msg;
        try { msg = JSON.parse(event.data); } catch (_) { return; }
        if (msg.s !== null && msg.s !== undefined) gatewaySeq = msg.s;
        switch (msg.op) {
            case 10:
                startGatewayHeartbeat(msg.d.heartbeat_interval);
                if (gatewaySessionId && gatewaySeq !== null) {
                    ws.send(JSON.stringify({ op: 6, d: { token: userToken, session_id: gatewaySessionId, seq: gatewaySeq } }));
                } else {
                    ws.send(JSON.stringify({ op: 2, d: { token: userToken, intents: 4609, properties: { os: 'browser', browser: 'chrome', device: '' } } }));
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
            gatewayReady = true; setGatewayStatus('connected', 'Connected \u2014 real-time'); clearTimeout(refreshTimeout);
            break;
        case 'RESUMED':
            gatewayReady = true; setGatewayStatus('connected', 'Connected \u2014 real-time'); clearTimeout(refreshTimeout);
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
    return crypto.subtle.deriveKey(
        { name: 'PBKDF2', salt: enc.encode(channelId), iterations: 100000, hash: 'SHA-256' },
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
    } catch { return '[Decryption failed \u2014 wrong key?]'; }
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
    saveE2EKeys(); updateE2EButton(); e2ePopover.classList.remove('active');
});

document.getElementById('e2e-clear-btn').addEventListener('click', () => {
    if (!currentChannelId) return;
    delete e2eKeys[currentChannelId]; delete e2eKeyCache[currentChannelId];
    saveE2EKeys(); updateE2EButton(); e2ePopover.classList.remove('active');
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
    } catch (err) { console.error('Failed to load guilds:', err); }
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
        dms.sort((a, b) => { try { const idA = BigInt(a.last_message_id || 0), idB = BigInt(b.last_message_id || 0); return idA < idB ? 1 : idA > idB ? -1 : 0; } catch (_) { return 0; } });
        dms.forEach(ch => {
            if (isBlocked(settings.blockedChannels, ch.id)) return;
            const name = ch.name || ch.recipients?.map(r => r.global_name || r.username).join(', ') || 'Unknown';
            const div = makeItem('channel-item', name, e => { setActiveChannel(e.currentTarget, name); markChannelRead(ch.id, ch.last_message_id); loadMessages(ch.id); });
            if (ch.last_message_id && isChannelUnread(ch.id, ch.last_message_id)) div.classList.add('unread');
            div.dataset.channelId = ch.id;
            div.addEventListener('contextmenu', e => showContextMenu(e, 'channel', ch.id, name));
            channelList.appendChild(div); parseTwemoji(div);
        });
    } catch (err) { console.error('Failed to load DMs:', err); }
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
    } catch (err) { console.error('Failed to load channels:', err); }
}

// ── Unread State ──────────────────────────────────────────
function isChannelUnread(channelId, lastMessageId) {
    if (!lastMessageId) return false;
    const lastRead = lastReadMessageIds[channelId];
    if (!lastRead) return true;
    try { return BigInt(lastMessageId) > BigInt(lastRead); } catch (_) { return lastMessageId !== lastRead; }
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
                    try { if (BigInt(msg.id) <= BigInt(prevLastId)) break; } catch (_) { if (msg.id === prevLastId) break; }
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
            proxyMedia(url).then(({ blobUrl }) => { activeBlobUrls.push(blobUrl); el.src = blobUrl; addDownloadLink(el, blobUrl, filename); })
                .catch(() => { const link = document.createElement('a'); link.href = url; link.target = '_blank'; link.className = 'download-link'; link.textContent = 'Open'; el.after(link); });
        } else {
            proxyMedia(url).then(({ blobUrl }) => { activeBlobUrls.push(blobUrl); el.href = blobUrl; el.download = filename; el.target = ''; })
                .catch(() => { el.href = url; el.target = '_blank'; });
        }
    });
}

// ── Send Message ──────────────────────────────────────────
sendButton.addEventListener('click', sendMessage);
messageInput.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } });

async function sendMessage() {
    let content = messageInput.value.trim();
    const hasFiles = fileInput.files.length > 0;
    if (!content && !hasFiles) return;
    if (!currentChannelId) return;
    messageInput.disabled = true; sendButton.disabled = true;
    try {
        if (content && e2eKeys[currentChannelId]) content = await e2eEncrypt(currentChannelId, content);
        let body, extraHeaders = {};
        if (hasFiles) { const fd = new FormData(); fd.append('file[0]', fileInput.files[0]); fd.append('payload_json', JSON.stringify({ content })); body = fd; }
        else { body = JSON.stringify({ content }); extraHeaders['Content-Type'] = 'application/json'; }
        const res = await fetch(`${getApiBase()}/channels/${currentChannelId}/messages`, { method: 'POST', headers: { 'Authorization': userToken, ...extraHeaders }, body });
        if (!res.ok) throw new Error(`Status ${res.status}`);
        messageInput.value = ''; fileInput.value = ''; fileBtn.classList.remove('active'); messageInput.placeholder = 'Message...';
        if (!gatewayReady) loadMessages(currentChannelId);
    } catch (err) { showToast(`Failed to send: ${err.message}`); messageInput.focus(); }
    finally { messageInput.disabled = false; sendButton.disabled = false; }
}

// ── Proxy / Media ─────────────────────────────────────────
async function proxyMedia(url) {
    let res;
    try {
        res = await fetch(`${clientConfig.proxyBase}/image`, { headers: { 'mediaurl': url }, mode: 'cors' });
    } catch (err) {
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
    } catch (err) { showToast(`Failed to open DM: ${err.message}`); }
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
if ('serviceWorker' in navigator) { const swBlob = new Blob([swCode], { type: 'application/javascript' }); const swUrl = URL.createObjectURL(swBlob); navigator.serviceWorker.register(swUrl, { scope: './' }).catch(() => {}); }

// ── Start ─────────────────────────────────────────────────
settingRefresh.value = settings.refreshInterval;
init();
