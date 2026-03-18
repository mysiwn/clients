// ══════════════════════════════════════════════════════════
// Shared Security Module — client/shared/security.js
// Provides encrypted storage, input validation, and crypto
// utilities for both Discord and Instagram clients.
// ══════════════════════════════════════════════════════════

// ── Constants ────────────────────────────────────────────
const PBKDF2_ITERATIONS = 600000;
const SALT_BYTES = 32;
const IV_BYTES = 12;
const VAULT_PREFIX = 'vault_';
const VAULT_META_KEY = 'vault_meta';

// ── SecureStorage ────────────────────────────────────────
// Encrypts all sensitive localStorage data with AES-256-GCM.
// Key derived from user PIN via PBKDF2 (600K iterations).
// Master key only held in memory — cleared on tab close.
class SecureStorage {
    constructor(namespace) {
        this.namespace = namespace;
        this.masterKey = null;
        this.isLocked = true;
    }

    // Derive AES key from PIN + salt using PBKDF2
    async _deriveKey(pin, salt) {
        const enc = new TextEncoder();
        const keyMaterial = await crypto.subtle.importKey(
            'raw', enc.encode(pin), 'PBKDF2', false, ['deriveKey']
        );
        return crypto.subtle.deriveKey(
            { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
            keyMaterial,
            { name: 'AES-GCM', length: 256 },
            false,
            ['encrypt', 'decrypt']
        );
    }

    // Encrypt plaintext with AES-256-GCM
    async _encrypt(key, plaintext) {
        const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
        const enc = new TextEncoder();
        const ciphertext = await crypto.subtle.encrypt(
            { name: 'AES-GCM', iv },
            key,
            enc.encode(plaintext)
        );
        // Combine IV + ciphertext into single base64 string
        const combined = new Uint8Array(IV_BYTES + ciphertext.byteLength);
        combined.set(iv, 0);
        combined.set(new Uint8Array(ciphertext), IV_BYTES);
        return btoa(String.fromCharCode(...combined));
    }

    // Decrypt base64 ciphertext with AES-256-GCM
    async _decrypt(key, base64Data) {
        const raw = Uint8Array.from(atob(base64Data), c => c.charCodeAt(0));
        const iv = raw.slice(0, IV_BYTES);
        const ciphertext = raw.slice(IV_BYTES);
        const plaintext = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv },
            key,
            ciphertext
        );
        return new TextDecoder().decode(plaintext);
    }

    // Check if a vault exists for this namespace
    hasVault() {
        return localStorage.getItem(this.namespace + '_' + VAULT_META_KEY) !== null;
    }

    // Create a new vault with the given PIN
    async create(pin) {
        if (!pin || pin.length < 4) {
            throw new Error('PIN must be at least 4 characters.');
        }
        const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
        const saltB64 = btoa(String.fromCharCode(...salt));
        this.masterKey = await this._deriveKey(pin, salt);

        // Store a verification token so we can check PIN correctness on unlock
        const verifyToken = crypto.getRandomValues(new Uint8Array(16));
        const verifyB64 = btoa(String.fromCharCode(...verifyToken));
        const encryptedVerify = await this._encrypt(this.masterKey, verifyB64);

        localStorage.setItem(this.namespace + '_' + VAULT_META_KEY, JSON.stringify({
            salt: saltB64,
            verify: encryptedVerify,
            verifyPlain: verifyB64,
            createdAt: Date.now()
        }));

        this.isLocked = false;
    }

    // Unlock an existing vault with PIN
    async unlock(pin) {
        const metaJson = localStorage.getItem(this.namespace + '_' + VAULT_META_KEY);
        if (!metaJson) throw new Error('No vault found. Create one first.');

        const meta = JSON.parse(metaJson);
        const salt = Uint8Array.from(atob(meta.salt), c => c.charCodeAt(0));
        const key = await this._deriveKey(pin, salt);

        // Verify PIN by decrypting the verification token
        try {
            const decrypted = await this._decrypt(key, meta.verify);
            if (decrypted !== meta.verifyPlain) throw new Error('PIN incorrect.');
        } catch {
            throw new Error('Invalid PIN.');
        }

        this.masterKey = key;
        this.isLocked = false;
    }

    // Lock the vault — clear master key from memory
    lock() {
        this.masterKey = null;
        this.isLocked = true;
    }

    // Store an encrypted value
    async setItem(key, value) {
        if (this.isLocked || !this.masterKey) throw new Error('Vault is locked.');
        const fullKey = this.namespace + '_' + VAULT_PREFIX + key;
        const encrypted = await this._encrypt(this.masterKey, value);
        try {
            localStorage.setItem(fullKey, encrypted);
        } catch (e) {
            if (e.name === 'QuotaExceededError') {
                throw new Error('Storage full. Clear some data and try again.');
            }
            throw e;
        }
    }

    // Retrieve and decrypt a value
    async getItem(key) {
        if (this.isLocked || !this.masterKey) return null;
        const fullKey = this.namespace + '_' + VAULT_PREFIX + key;
        const encrypted = localStorage.getItem(fullKey);
        if (!encrypted) return null;
        try {
            return await this._decrypt(this.masterKey, encrypted);
        } catch {
            console.warn(`[SecureStorage] Failed to decrypt key: ${key}`);
            return null;
        }
    }

    // Securely remove a value (overwrite then delete)
    removeItem(key) {
        const fullKey = this.namespace + '_' + VAULT_PREFIX + key;
        // Overwrite with random data before deleting
        try {
            const junk = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(64))));
            localStorage.setItem(fullKey, junk);
        } catch { /* ignore overwrite failures */ }
        localStorage.removeItem(fullKey);
    }

    // Destroy the entire vault
    destroy() {
        const prefix = this.namespace + '_';
        const keys = [];
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k && k.startsWith(prefix)) keys.push(k);
        }
        for (const k of keys) {
            try {
                localStorage.setItem(k, btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(64)))));
            } catch { /* ignore */ }
            localStorage.removeItem(k);
        }
        this.lock();
    }
}

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

// ── CryptoUtils ──────────────────────────────────────────
const CryptoUtils = {
    // Generate a cryptographically random client ID (UUID v4)
    generateClientId() {
        return crypto.randomUUID();
    },

    // Generate random bytes as hex string
    randomHex(bytes = 32) {
        const buf = crypto.getRandomValues(new Uint8Array(bytes));
        return Array.from(buf).map(b => b.toString(16).padStart(2, '0')).join('');
    },

    // Constant-time string comparison (timing-safe)
    constantTimeEqual(a, b) {
        if (typeof a !== 'string' || typeof b !== 'string') return false;
        if (a.length !== b.length) return false;
        let result = 0;
        for (let i = 0; i < a.length; i++) {
            result |= a.charCodeAt(i) ^ b.charCodeAt(i);
        }
        return result === 0;
    },

    // Generate ECDH key pair for proxy encryption
    async generateECDHKeyPair() {
        const keyPair = await crypto.subtle.generateKey(
            { name: 'ECDH', namedCurve: 'P-256' },
            true,
            ['deriveKey', 'deriveBits']
        );
        const publicJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
        return {
            privateKey: keyPair.privateKey,
            publicKey: keyPair.publicKey,
            publicJwk: {
                kty: publicJwk.kty,
                crv: publicJwk.crv,
                x: publicJwk.x,
                y: publicJwk.y
            }
        };
    },

    // Derive AES key from ECDH shared secret
    async deriveAESFromECDH(privateKey, serverPublicJwk, info) {
        const serverKey = await crypto.subtle.importKey(
            'jwk', serverPublicJwk,
            { name: 'ECDH', namedCurve: 'P-256' },
            true, []
        );
        const sharedBits = await crypto.subtle.deriveBits(
            { name: 'ECDH', public: serverKey },
            privateKey,
            256
        );
        const hkdfKey = await crypto.subtle.importKey(
            'raw', sharedBits, 'HKDF', false, ['deriveKey']
        );
        const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
        return crypto.subtle.deriveKey(
            {
                name: 'HKDF',
                hash: 'SHA-256',
                salt,
                info: new TextEncoder().encode(info)
            },
            hkdfKey,
            { name: 'AES-GCM', length: 256 },
            false,
            ['encrypt', 'decrypt']
        );
    },

    // Encrypt payload with AES-256-GCM
    async encryptPayload(aesKey, data) {
        const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
        const encoded = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
        const ciphertext = await crypto.subtle.encrypt(
            { name: 'AES-GCM', iv },
            aesKey,
            encoded
        );
        const combined = new Uint8Array(IV_BYTES + ciphertext.byteLength);
        combined.set(iv, 0);
        combined.set(new Uint8Array(ciphertext), IV_BYTES);
        return btoa(String.fromCharCode(...combined));
    },

    // Decrypt payload with AES-256-GCM
    async decryptPayload(aesKey, base64Data) {
        const raw = Uint8Array.from(atob(base64Data), c => c.charCodeAt(0));
        const iv = raw.slice(0, IV_BYTES);
        const ciphertext = raw.slice(IV_BYTES);
        const plaintext = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv },
            aesKey,
            ciphertext
        );
        return new TextDecoder().decode(plaintext);
    }
};

// ── Exports (global for non-module scripts) ──────────────
window.SecureStorage = SecureStorage;
window.InputValidator = InputValidator;
window.CryptoUtils = CryptoUtils;
