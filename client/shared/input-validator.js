// ── InputValidator ───────────────────────────────────────
const InputValidator = {
    // Validate HTTPS URL
    isValidHttpsUrl(str) {
        try {
            const u = new URL(str);
            return u.protocol === 'https:';
        } catch { return false; }
    },

    // Validate Discord snowflake ID
    isValidSnowflake(str) {
        return /^\d{17,20}$/.test(str);
    },

    // Validate file upload (type whitelist + size limit)
    validateFileUpload(file, maxSizeMB = 25) {
        if (!file) return { valid: false, reason: 'No file selected.' };
        const maxBytes = maxSizeMB * 1024 * 1024;
        if (file.size > maxBytes) {
            return { valid: false, reason: `File too large (max ${maxSizeMB}MB).` };
        }
        if (file.size === 0) {
            return { valid: false, reason: 'File is empty.' };
        }
        // Allow common file types
        const allowedTypes = [
            'image/', 'video/', 'audio/', 'text/',
            'application/pdf', 'application/zip',
            'application/json', 'application/xml',
            'application/octet-stream'
        ];
        const typeOk = allowedTypes.some(t => file.type.startsWith(t) || file.type === t);
        if (!typeOk && file.type) {
            return { valid: false, reason: `File type '${file.type}' not allowed.` };
        }
        return { valid: true };
    },

    // Validate proxy media URL (prevent SSRF)
    isAllowedMediaUrl(urlStr) {
        try {
            const u = new URL(urlStr);
            if (u.protocol !== 'https:') return false;
            const host = u.hostname.toLowerCase();
            const allowed = [
                'cdn.discordapp.com', 'media.discordapp.net',
                'images-ext-1.discordapp.net', 'images-ext-2.discordapp.net',
                'i.instagram.com', 'scontent.cdninstagram.com'
            ];
            return allowed.some(d => host === d || host.endsWith('.' + d)) ||
                   host.endsWith('.cdninstagram.com') ||
                   host.endsWith('.discordapp.net');
        } catch { return false; }
    },

    // Validate WebSocket URL
    isValidWsUrl(str) {
        try {
            const u = new URL(str);
            return u.protocol === 'wss:' || u.protocol === 'ws:';
        } catch { return false; }
    },

    // Sanitize text for display (HTML entity escaping)
    escapeHtml(str) {
        return (str || '').replace(/[&<>"']/g, c => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
        }[c]));
    },

    // Validate API response has expected shape
    validateShape(data, requiredKeys) {
        if (!data || typeof data !== 'object') return false;
        return requiredKeys.every(k => k in data);
    }
};

window.InputValidator = InputValidator;
