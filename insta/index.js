// ══════════════════════════════════════════════════════════
// Static Instagram Client — index.js
// ══════════════════════════════════════════════════════════

// ── Helpers ───────────────────────────────────────────────
function escapeHtml(str) {
    return (str || '').replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
    }[c]));
}

function isValidHttpsUrl(str) {
    try {
        const u = new URL(str);
        return u.protocol === 'https:';
    } catch { return false; }
}

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

function loadClientConfig() {
    try {
        const saved = JSON.parse(localStorage.getItem('ig_client_config'));
        if (saved && typeof saved === 'object') {
            const cfg = { ...DEFAULT_CONFIG, ...saved };
            if (!isValidHttpsUrl(cfg.proxyBase)) return null;
            if (!VALID_NOTIFY_MODES.includes(cfg.notifyMode)) cfg.notifyMode = 'dm';
            return cfg;
        }
    } catch (_) {}
    return null;
}

function saveClientConfig(cfg) {
    localStorage.setItem('ig_client_config', JSON.stringify(cfg));
    clientConfig = cfg;
}

let clientConfig = loadClientConfig();

// Instagram API base
const IG_API_BASE = 'https://i.instagram.com/api/v1';
const IG_APP_ID = '936619743392459';

function getApiUrl(endpoint) {
    return clientConfig.proxyBase + '/' + IG_API_BASE + endpoint;
}

// ── State ─────────────────────────────────────────────────
let sessionId       = '';
let csrfToken       = '';
let currentUserId   = '';
let currentUsername  = '';
let currentView     = 'feed';
let currentThreadId = null;
let refreshTimeout  = null;
let isConnecting    = false;
let activeBlobUrls  = [];

// ── Settings ──────────────────────────────────────────────
let settings = {
    refreshInterval: 0
};

function loadSettings() {
    try {
        const saved = JSON.parse(localStorage.getItem('ig_settings'));
        if (saved && typeof saved === 'object') settings = { ...settings, ...saved };
    } catch (_) {}
}
loadSettings();

function saveSettings() {
    localStorage.setItem('ig_settings', JSON.stringify(settings));
    startAutoRefresh();
}

// ── DOM Refs ──────────────────────────────────────────────
const setupScreen     = document.getElementById('setup-screen');
const loginScreen     = document.getElementById('login-screen');
const appScreen       = document.getElementById('app');
const sessionInput    = document.getElementById('session-input');
const loginButton     = document.getElementById('login-button');
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
    return {
        'Cookie': `sessionid=${sessionId}; csrftoken=${csrfToken}`,
        'X-CSRFToken': csrfToken,
        'X-IG-App-ID': IG_APP_ID,
        'User-Agent': 'Instagram 275.0.0.27.98 Android (33/13; 420dpi; 1080x2400; samsung; SM-G991B; o1s; exynos2100; en_US; 458229258)',
        'Content-Type': 'application/x-www-form-urlencoded'
    };
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
    if (!clientConfig) { setupScreen.style.display = 'flex'; }
    else { showLoginScreen(); }
}

function showLoginScreen() {
    const savedSession = sessionStorage.getItem('ig_session_id');
    const savedCsrf = sessionStorage.getItem('ig_csrf_token');
    if (savedSession) {
        sessionInput.value = savedSession;
        loginScreen.style.display = 'flex';
        connectWithSession(savedSession, savedCsrf || '');
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
    });
});

function showLoginError(msg) {
    loginError.textContent = msg;
    loginError.style.display = msg ? 'block' : 'none';
}

function resetMfaState() {
    document.getElementById('mfa-section').classList.remove('active');
    document.getElementById('challenge-section').classList.remove('active');
    document.getElementById('credential-fields').classList.remove('hidden');
    const mfaCode = document.getElementById('mfa-code');
    if (mfaCode) mfaCode.value = '';
}

// ── Credential Login ──────────────────────────────────────
const credLoginBtn  = document.getElementById('cred-login-button');
const credUsername   = document.getElementById('cred-username');
const credPassword   = document.getElementById('cred-password');
const mfaCodeInput  = document.getElementById('mfa-code');
const mfaSubmitBtn  = document.getElementById('mfa-submit-button');
const challengeCode = document.getElementById('challenge-code');
const challengeBtn  = document.getElementById('challenge-submit-button');

let loginTwoFactorInfo = null;
let challengeUrl = null;

credLoginBtn.addEventListener('click', () => loginWithCredentials());
credPassword.addEventListener('keydown', e => { if (e.key === 'Enter') loginWithCredentials(); });

async function loginWithCredentials() {
    const username = credUsername.value.trim();
    const password = credPassword.value;
    if (!username || !password) return;
    credLoginBtn.disabled = true;
    credLoginBtn.textContent = 'Logging in...';
    showLoginError('');
    try {
        const time = Math.floor(Date.now() / 1000);
        const encPassword = `#PWD_INSTAGRAM_BROWSER:0:${time}:${password}`;
        const body = new URLSearchParams({
            username,
            enc_password: encPassword,
            queryParams: '{}',
            optIntoOneTap: 'false'
        });
        let res;
        try {
            res = await fetch(getApiUrl('/accounts/login/'), {
                method: 'POST',
                headers: {
                    'X-IG-App-ID': IG_APP_ID,
                    'X-CSRFToken': 'missing',
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'User-Agent': 'Instagram 275.0.0.27.98 Android'
                },
                body: body.toString(),
                mode: 'cors'
            });
        } catch (err) {
            throw new Error('Connection failed. Make sure your proxy URL is correct and you have internet access.');
        }
        const data = await res.json();
        if (data.authenticated && data.userId) {
            const cookies = res.headers.get('set-cookie') || '';
            const sidMatch = cookies.match(/sessionid=([^;]+)/);
            const csrfMatch = cookies.match(/csrftoken=([^;]+)/);
            const sid = sidMatch ? sidMatch[1] : '';
            const csrf = csrfMatch ? csrfMatch[1] : '';
            if (sid) {
                connectWithSession(sid, csrf);
            } else {
                showLoginError('Login succeeded but no session cookie received. Use Session ID tab instead.');
            }
            return;
        }
        if (data.two_factor_required) {
            loginTwoFactorInfo = data.two_factor_info;
            document.getElementById('credential-fields').classList.add('hidden');
            document.getElementById('mfa-section').classList.add('active');
            mfaCodeInput.focus();
            return;
        }
        if (data.checkpoint_url || data.challenge) {
            challengeUrl = data.checkpoint_url || data.challenge?.url;
            document.getElementById('credential-fields').classList.add('hidden');
            document.getElementById('challenge-section').classList.add('active');
            challengeCode.focus();
            showLoginError('A security code was sent to your email/phone.');
            return;
        }
        showLoginError(data.message || `Login failed (${res.status})`);
    } catch (err) {
        showLoginError(`Login failed: ${err.message}`);
    } finally {
        credLoginBtn.disabled = false;
        credLoginBtn.textContent = 'Log In';
    }
}

// ── MFA ───────────────────────────────────────────────────
mfaSubmitBtn.addEventListener('click', () => submitMFA());
mfaCodeInput.addEventListener('keydown', e => { if (e.key === 'Enter') submitMFA(); });

async function submitMFA() {
    const code = mfaCodeInput.value.trim();
    if (!code || !loginTwoFactorInfo) return;
    mfaSubmitBtn.disabled = true;
    mfaSubmitBtn.textContent = 'Verifying...';
    showLoginError('');
    try {
        const body = new URLSearchParams({
            username: loginTwoFactorInfo.username,
            verification_code: code,
            two_factor_identifier: loginTwoFactorInfo.two_factor_identifier,
            trust_this_device: '1'
        });
        const res = await fetch(getApiUrl('/accounts/two_factor_login/'), {
            method: 'POST',
            headers: {
                'X-IG-App-ID': IG_APP_ID,
                'Content-Type': 'application/x-www-form-urlencoded',
                'User-Agent': 'Instagram 275.0.0.27.98 Android'
            },
            body: body.toString()
        });
        const data = await res.json();
        if (data.authenticated && data.userId) {
            const cookies = res.headers.get('set-cookie') || '';
            const sidMatch = cookies.match(/sessionid=([^;]+)/);
            const csrfMatch = cookies.match(/csrftoken=([^;]+)/);
            const sid = sidMatch ? sidMatch[1] : '';
            const csrf = csrfMatch ? csrfMatch[1] : '';
            if (sid) {
                resetMfaState();
                connectWithSession(sid, csrf);
            } else {
                showLoginError('2FA succeeded but no session cookie. Use Session ID tab.');
            }
            return;
        }
        showLoginError(data.message || `2FA failed (${res.status})`);
    } catch (err) {
        showLoginError(`2FA failed: ${err.message}`);
    } finally {
        mfaSubmitBtn.disabled = false;
        mfaSubmitBtn.textContent = 'Verify';
    }
}

// ── Challenge ─────────────────────────────────────────────
challengeBtn.addEventListener('click', () => submitChallenge());
challengeCode.addEventListener('keydown', e => { if (e.key === 'Enter') submitChallenge(); });

async function submitChallenge() {
    const code = challengeCode.value.trim();
    if (!code || !challengeUrl) return;
    challengeBtn.disabled = true;
    challengeBtn.textContent = 'Submitting...';
    showLoginError('');
    try {
        const body = new URLSearchParams({ security_code: code });
        const res = await fetch(clientConfig.proxyBase + '/https://i.instagram.com' + challengeUrl, {
            method: 'POST',
            headers: {
                'X-IG-App-ID': IG_APP_ID,
                'Content-Type': 'application/x-www-form-urlencoded',
                'User-Agent': 'Instagram 275.0.0.27.98 Android'
            },
            body: body.toString()
        });
        const data = await res.json();
        if (data.logged_in_user) {
            const cookies = res.headers.get('set-cookie') || '';
            const sidMatch = cookies.match(/sessionid=([^;]+)/);
            const csrfMatch = cookies.match(/csrftoken=([^;]+)/);
            const sid = sidMatch ? sidMatch[1] : '';
            const csrf = csrfMatch ? csrfMatch[1] : '';
            if (sid) {
                resetMfaState();
                connectWithSession(sid, csrf);
            } else {
                showLoginError('Challenge passed but no session cookie. Use Session ID tab.');
            }
            return;
        }
        showLoginError(data.message || `Challenge failed (${res.status})`);
    } catch (err) {
        showLoginError(`Challenge failed: ${err.message}`);
    } finally {
        challengeBtn.disabled = false;
        challengeBtn.textContent = 'Submit';
    }
}

// ── Session Connect ───────────────────────────────────────
async function connectWithSession(sid, csrf) {
    if (isConnecting) return;
    isConnecting = true;
    sessionId = sid.trim();
    csrfToken = csrf.trim() || 'missing';
    loginButton.textContent = 'Connecting...';
    loginButton.disabled = true;
    showLoginError('');
    try {
        let res;
        try {
            res = await fetch(getApiUrl('/accounts/current_user/?edit=true'), {
                headers: igHeaders(),
                mode: 'cors'
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
        sessionStorage.setItem('ig_session_id', sessionId);
        sessionStorage.setItem('ig_csrf_token', csrfToken);
        loginScreen.style.display = 'none';
        appScreen.style.display = 'flex';
        if (clientConfig.notifyMode !== 'off' && 'Notification' in window && Notification.permission === 'default') Notification.requestPermission();
        setConnectionStatus('polling', 'Polling');
        loadFeed();
        startAutoRefresh();
    } catch (err) {
        showLoginError(`Connection failed: ${err.message}`);
        loginButton.textContent = 'Connect';
        loginButton.disabled = false;
        sessionStorage.removeItem('ig_session_id');
        sessionStorage.removeItem('ig_csrf_token');
        sessionInput.value = '';
    } finally {
        isConnecting = false;
    }
}

loginButton.addEventListener('click', () => connectWithSession(sessionInput.value.trim(), ''));
sessionInput.addEventListener('keydown', e => { if (e.key === 'Enter') connectWithSession(sessionInput.value.trim(), ''); });

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
        res = await fetch(getApiUrl(endpoint), { ...options, headers, mode: 'cors' });
    } catch (err) {
        throw new Error('Connection failed. Check your proxy URL and network connection.');
    }
    if (!res.ok) throw new Error(`API ${res.status}`);
    return res.json();
}

// ── Proxy Media ───────────────────────────────────────────
async function proxyMedia(url) {
    let res;
    try {
        res = await fetch(`${clientConfig.proxyBase}/image`, { headers: { 'mediaurl': url }, mode: 'cors' });
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
    imgEl.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
    proxyMedia(url).then(blobUrl => {
        activeBlobUrls.push(blobUrl);
        imgEl.src = blobUrl;
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
        proxyMedia(videoUrl).then(blobUrl => { activeBlobUrls.push(blobUrl); video.src = blobUrl; }).catch(() => { video.src = videoUrl; });
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
        } catch (_) {}
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
        proxyMedia(url).then(blobUrl => { activeBlobUrls.push(blobUrl); video.src = blobUrl; }).catch(() => { video.src = url; });
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
        const data = await igApi('/direct_v2/inbox/?visual_message_return_type=unseen&persistentBadging=true&limit=20');
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
                proxyMedia(url).then(blobUrl => { activeBlobUrls.push(blobUrl); video.src = blobUrl; }).catch(() => { video.src = url; });
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
    } catch (_) {}
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
                const data = await igApi(`/users/search/?q=${encodeURIComponent(q)}&count=15`);
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
            } catch (_) {}
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
function openSettings() {
    settingProxyUrl.value = clientConfig.proxyBase;
    settingNotifyMode.value = clientConfig.notifyMode || 'dm';
    settingRefresh.value = settings.refreshInterval;
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
    settings.refreshInterval = val === 0 ? 0 : Math.max(30, val);
    settingRefresh.value = settings.refreshInterval;
    saveSettings();
});

document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
        closeSettings();
        closeNewDmModal();
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
if ('serviceWorker' in navigator) { const swBlob = new Blob([swCode], { type: 'application/javascript' }); const swUrl = URL.createObjectURL(swBlob); navigator.serviceWorker.register(swUrl, { scope: './' }).catch(() => {}); }

// ── Start ─────────────────────────────────────────────────
settingRefresh.value = settings.refreshInterval;
init();
