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
