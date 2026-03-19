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
