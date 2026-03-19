// ── CryptoUtils ──────────────────────────────────────────
const SALT_BYTES = 32;
const IV_BYTES   = 12;

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

window.CryptoUtils = CryptoUtils;
