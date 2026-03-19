// ── SecureStorage ────────────────────────────────────────
// Encrypts all sensitive localStorage data with AES-256-GCM.
// Key derived from user PIN via PBKDF2 (600K iterations).
// Master key only held in memory — cleared on tab close.

const PBKDF2_ITERATIONS = 600000;
const SALT_BYTES        = 32;
const IV_BYTES          = 12;
const VAULT_PREFIX      = 'vault_';
const VAULT_META_KEY    = 'vault_meta';

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

        // Store encrypted well-known constant for PIN verification on unlock
        const VERIFY_PLAINTEXT = 'vault-pin-check-v1';
        const encryptedVerify = await this._encrypt(this.masterKey, VERIFY_PLAINTEXT);

        localStorage.setItem(this.namespace + '_' + VAULT_META_KEY, JSON.stringify({
            salt: saltB64,
            verify: encryptedVerify,
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
            const expected = meta.verifyPlain || 'vault-pin-check-v1';
            if (decrypted !== expected) throw new Error('PIN incorrect.');
        } catch {
            throw new Error('Invalid PIN.');
        }

        // Migrate old vaults: remove plaintext verifyPlain, re-encrypt with constant
        if (meta.verifyPlain) {
            const newVerify = await this._encrypt(key, 'vault-pin-check-v1');
            delete meta.verifyPlain;
            meta.verify = newVerify;
            localStorage.setItem(this.namespace + '_' + VAULT_META_KEY, JSON.stringify(meta));
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
        } catch (err) {
            throw new Error(`Decryption failed for key "${key}": data may be corrupted`);
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

window.SecureStorage = SecureStorage;
