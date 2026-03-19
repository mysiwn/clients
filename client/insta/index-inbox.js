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

// ── Cleanup on unload ─────────────────────────────────────
window.addEventListener('beforeunload', () => {
    clearBlobUrls();
    clearTimeout(refreshTimeout);
    clearTimeout(searchTimeout);
    if (browserWs) { try { browserWs.close(); } catch (_) {} }
});

// ── Start ─────────────────────────────────────────────────
settingRefresh.value = settings.refreshInterval;
init();
