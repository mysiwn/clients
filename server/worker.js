// server/worker.js — Hardened Unified CORS proxy for Discord + Instagram

// ── Allowed domains (SSRF prevention) ─────────────────────
const DISCORD_HOSTS = new Set([
  "discord.com",
  "cdn.discordapp.com",
  "media.discordapp.net",
  "images-ext-1.discordapp.net",
  "images-ext-2.discordapp.net",
  "gateway.discord.gg"
]);

const INSTAGRAM_HOSTS = new Set([
  "i.instagram.com",
  "www.instagram.com",
  "instagram.com",
  "graph.instagram.com",
  "scontent.cdninstagram.com"
]);

function getService(hostname) {
  if (DISCORD_HOSTS.has(hostname)) return "discord";
  if (INSTAGRAM_HOSTS.has(hostname)) return "instagram";
  for (const h of DISCORD_HOSTS) {
    if (hostname.endsWith("." + h)) return "discord";
  }
  for (const h of INSTAGRAM_HOSTS) {
    if (hostname.endsWith("." + h)) return "instagram";
  }
  if (hostname.endsWith(".cdninstagram.com")) return "instagram";
  return null;
}

function isAllowedHost(hostname) {
  return getService(hostname) !== null;
}

// ── CORS helpers ──────────────────────────────────────────
const CORS_METHODS = "GET, POST, PUT, PATCH, DELETE, OPTIONS";
const CORS_ALLOW_HEADERS = "Authorization, Content-Type, Cookie, X-CSRFToken, X-IG-App-ID, mediaurl, X-Encrypted-Auth, X-Client-Id, X-IG-Session, X-IG-Csrf, X-IG-Full-Cookie";
const CORS_EXPOSE_HEADERS = "Content-Type, Content-Length, X-Cache, Set-Cookie, X-Encrypted-Body";
const CORS_MAX_AGE = "86400";

function getCorsHeaders(origin, env) {
  let allowedOrigin = "*";
  if (env && env.ALLOWED_ORIGINS) {
    const allowed = env.ALLOWED_ORIGINS.split(",").map(s => s.trim());
    if (origin && allowed.includes(origin)) {
      allowedOrigin = origin;
    } else {
      allowedOrigin = allowed[0] || "*";
    }
  } else if (origin) {
    allowedOrigin = "*";
  }
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": CORS_METHODS,
    "Access-Control-Allow-Headers": CORS_ALLOW_HEADERS,
    "Access-Control-Expose-Headers": CORS_EXPOSE_HEADERS,
    "Access-Control-Max-Age": CORS_MAX_AGE,
    "Vary": "Origin"
  };
}

const BLOCKED_RESPONSE_HEADERS = new Set([
  "access-control-allow-origin",
  "access-control-allow-methods",
  "access-control-allow-headers",
  "access-control-allow-credentials",
  "access-control-expose-headers",
  "x-frame-options",
  "content-security-policy",
  "content-security-policy-report-only"
]);

// ── User agents per service ───────────────────────────────
const USER_AGENTS = {
  discord: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
  instagram: "Instagram 275.0.0.27.98 Android (33/13; 420dpi; 1080x2400; samsung; SM-G991B; o1s; exynos2100; en_US; 458229258)"
};

// ── Rate limiting (in-memory per-isolate) ─────────────────
const rateLimitMap = new Map();
const RATE_LIMIT_MAP_CAP = 5000;

const RATE_LIMITS = {
  proxy: { max: 120, windowMs: 60000 },
  image: { max: 30, windowMs: 60000 },
  register: { max: 5, windowMs: 60000 },
  mirrors: { max: 10, windowMs: 60000 }
};

function checkRateLimit(ip, bucket) {
  const now = Date.now();
  const limit = RATE_LIMITS[bucket];
  const key = ip + ":" + bucket;
  let entry = rateLimitMap.get(key);
  if (!entry || (now - entry.windowStart) > limit.windowMs) {
    entry = { windowStart: now, count: 0 };
    rateLimitMap.set(key, entry);
  }
  entry.count++;
  if (entry.count > limit.max) {
    const retryAfter = Math.ceil((entry.windowStart + limit.windowMs - now) / 1000);
    return retryAfter > 0 ? retryAfter : 1;
  }
  // Bounded cleanup: cap at RATE_LIMIT_MAP_CAP with aggressive threshold
  if (rateLimitMap.size > RATE_LIMIT_MAP_CAP) {
    const aggressiveThreshold = now - 30000; // 30s aggressive cleanup
    for (const [k, v] of rateLimitMap) {
      if (v.windowStart < aggressiveThreshold) {
        rateLimitMap.delete(k);
      }
    }
    // If still over cap, evict oldest entry (O(n) single pass)
    if (rateLimitMap.size > RATE_LIMIT_MAP_CAP) {
      let oldestTime = Infinity, oldestKey = null;
      for (const [k, v] of rateLimitMap) {
        if (v.windowStart < oldestTime) { oldestTime = v.windowStart; oldestKey = k; }
      }
      if (oldestKey) rateLimitMap.delete(oldestKey);
    }
  }
  return 0;
}

function rateLimitResponse(retryAfter, origin, env, requestId) {
  return new Response(JSON.stringify({ error: "Rate limit exceeded", requestId }), {
    status: 429,
    headers: {
      "Content-Type": "application/json",
      "Retry-After": String(retryAfter),
      ...getCorsHeaders(origin, env)
    }
  });
}

// ── Structured error helper ───────────────────────────────
function errJson(status, message, requestId, origin, env) {
  return new Response(JSON.stringify({ error: message, requestId }), {
    status,
    headers: { "Content-Type": "application/json", ...getCorsHeaders(origin, env) }
  });
}

// ── Request body size limit (10 MB) ───────────────────────
const MAX_BODY_SIZE = 10 * 1024 * 1024;

function checkBodySize(request) {
  const cl = request.headers.get("Content-Length");
  if (cl && parseInt(cl, 10) > MAX_BODY_SIZE) {
    return true;
  }
  return false;
}

// ── ECDH / Crypto helpers ─────────────────────────────────

// Module-level cache for shared secrets with TTL + bounds
const sharedSecretCache = new Map();
const SHARED_SECRET_MAX = 1000;
const SHARED_SECRET_TTL = 5 * 60 * 1000; // 5 minutes

function cleanSharedSecretCache() {
  const now = Date.now();
  for (const [k, v] of sharedSecretCache) {
    if (now - v.timestamp > SHARED_SECRET_TTL) {
      sharedSecretCache.delete(k);
    }
  }
}

let lastCacheClean = 0;
const CACHE_CLEAN_INTERVAL = 30000; // 30s

function getCachedSharedSecret(cacheKey) {
  const now = Date.now();
  if (now - lastCacheClean > CACHE_CLEAN_INTERVAL) {
    lastCacheClean = now;
    cleanSharedSecretCache();
  }
  const entry = sharedSecretCache.get(cacheKey);
  if (entry && (Date.now() - entry.timestamp <= SHARED_SECRET_TTL)) {
    return entry.aesKey;
  }
  if (entry) sharedSecretCache.delete(cacheKey);
  return null;
}

function setCachedSharedSecret(cacheKey, aesKey) {
  // Enforce max size
  if (sharedSecretCache.size >= SHARED_SECRET_MAX) {
    // Evict oldest
    let oldestKey = null, oldestTime = Infinity;
    for (const [k, v] of sharedSecretCache) {
      if (v.timestamp < oldestTime) {
        oldestTime = v.timestamp;
        oldestKey = k;
      }
    }
    if (oldestKey) sharedSecretCache.delete(oldestKey);
  }
  sharedSecretCache.set(cacheKey, { aesKey, timestamp: Date.now() });
}

// Module-level cache for imported ECDH private key
let privateKeyCache = null; // { key, jwkHash, timestamp }
const PRIVATE_KEY_TTL = 5 * 60 * 1000; // 5 minutes

async function importECDHPrivateKey(jwkJson) {
  const jwkStr = typeof jwkJson === "string" ? jwkJson : JSON.stringify(jwkJson);
  const now = Date.now();
  if (privateKeyCache && privateKeyCache.jwkHash === jwkStr && (now - privateKeyCache.timestamp) < PRIVATE_KEY_TTL) {
    return privateKeyCache.key;
  }
  const jwk = typeof jwkJson === "string" ? JSON.parse(jwkJson) : jwkJson;
  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveKey", "deriveBits"]
  );
  privateKeyCache = { key, jwkHash: jwkStr, timestamp: now };
  return key;
}

async function importECDHPublicKey(jwk) {
  const parsed = typeof jwk === "string" ? JSON.parse(jwk) : jwk;
  return crypto.subtle.importKey(
    "jwk",
    parsed,
    { name: "ECDH", namedCurve: "P-256" },
    true,
    []
  );
}

async function deriveSharedKey(privateKey, publicKey) {
  const sharedBits = await crypto.subtle.deriveBits(
    { name: "ECDH", public: publicKey },
    privateKey,
    256
  );
  return crypto.subtle.importKey(
    "raw",
    sharedBits,
    "HKDF",
    false,
    ["deriveKey"]
  );
}

async function deriveAESKey(hkdfKey, service, salt) {
  const info = service === "instagram" ? "insta-cors-proxy-e2e" : "discord-cors-proxy-e2e";
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: salt,
      info: new TextEncoder().encode(info)
    },
    hkdfKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

async function getSharedAESKey(privateKey, clientPublicKeyJwk, service, salt) {
  const cacheKey = JSON.stringify(clientPublicKeyJwk) + ":" + service;
  const cached = getCachedSharedSecret(cacheKey);
  if (cached) return cached;

  const pubKey = await importECDHPublicKey(clientPublicKeyJwk);
  const hkdfKey = await deriveSharedKey(privateKey, pubKey);
  const aesKey = await deriveAESKey(hkdfKey, service, salt);
  setCachedSharedSecret(cacheKey, aesKey);
  return aesKey;
}

async function encryptPayload(aesKey, data) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    aesKey,
    encoded
  );
  const combined = new Uint8Array(12 + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), 12);
  return btoa(String.fromCharCode(...combined));
}

async function decryptPayload(aesKey, base64Data) {
  const raw = Uint8Array.from(atob(base64Data), (c) => c.charCodeAt(0));
  const iv = raw.slice(0, 12);
  const ciphertext = raw.slice(12);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    aesKey,
    ciphertext
  );
  return new TextDecoder().decode(plaintext);
}

async function getWorkerPublicJwk(privateKey) {
  const fullJwk = await crypto.subtle.exportKey("jwk", privateKey);
  return {
    kty: fullJwk.kty,
    crv: fullJwk.crv,
    x: fullJwk.x,
    y: fullJwk.y
  };
}

// ── Validation helpers ────────────────────────────────────
const CLIENT_ID_REGEX = /^[a-zA-Z0-9-]{1,64}$/;

function validateClientId(clientId) {
  return typeof clientId === "string" && CLIENT_ID_REGEX.test(clientId);
}

function validatePublicKeyJwk(publicKey) {
  if (!publicKey || typeof publicKey !== "object") return false;
  if (publicKey.kty !== "EC") return false;
  if (publicKey.crv !== "P-256") return false;
  if (typeof publicKey.x !== "string" || !publicKey.x) return false;
  if (typeof publicKey.y !== "string" || !publicKey.y) return false;
  return true;
}

// ── Salt helpers ──────────────────────────────────────────
function generateSalt() {
  return crypto.getRandomValues(new Uint8Array(32));
}

function saltToBase64(salt) {
  return btoa(String.fromCharCode(...salt));
}

function base64ToSalt(b64) {
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}

async function getClientSalt(clientsKv, kvKey) {
  const saltB64 = await clientsKv.get(kvKey + ":salt");
  if (saltB64) return base64ToSalt(saltB64);
  return null;
}

async function storeClientSalt(clientsKv, kvKey, salt) {
  await clientsKv.put(kvKey + ":salt", saltToBase64(salt));
}

// ── Image handler with KV caching ────────────────────────
async function handleImageRequest(request, env, ctx, origin, requestId) {
  const mediaUrl = request.headers.get("mediaurl");
  if (!mediaUrl) {
    return errJson(400, "Missing 'mediaurl' header", requestId, origin, env);
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(mediaUrl);
  } catch {
    return errJson(400, "Invalid media URL", requestId, origin, env);
  }

  const service = getService(parsedUrl.hostname);
  if (!service) {
    return errJson(403, "Media domain not allowed", requestId, origin, env);
  }

  const kv = env.IMAGE_CACHE;
  const corsHeaders = getCorsHeaders(origin, env);

  // Try KV cache first
  if (kv) {
    try {
      const { value, metadata } = await kv.getWithMetadata(mediaUrl, { type: "arrayBuffer" });
      if (value) {
        const headers = new Headers(corsHeaders);
        headers.set("Content-Type", metadata?.contentType || "application/octet-stream");
        headers.set("Cache-Control", "public, max-age=31536000, immutable");
        headers.set("X-Cache", "HIT");
        return new Response(value, { status: 200, headers });
      }
    } catch (_) {
      // KV read failed, fall through to fetch
    }
  }

  // Fetch upstream with timeout
  let upstream;
  try {
    upstream = await fetch(parsedUrl.toString(), {
      headers: {
        "User-Agent": USER_AGENTS[service] || USER_AGENTS.discord,
        "Accept": "image/*,*/*;q=0.8",
        "Referer": parsedUrl.origin + "/"
      },
      redirect: "follow",
      signal: AbortSignal.timeout(15000)
    });
  } catch (err) {
    return errJson(502, "Upstream fetch failed", requestId, origin, env);
  }

  if (!upstream.ok) {
    return errJson(upstream.status, "Upstream error", requestId, origin, env);
  }

  const contentType = upstream.headers.get("content-type") || "application/octet-stream";
  const body = await upstream.arrayBuffer();

  // Store in KV (non-blocking, 2 day TTL)
  if (kv && body.byteLength < 25 * 1024 * 1024) {
    const waitUntil = ctx?.waitUntil?.bind(ctx) || env.ctx?.waitUntil?.bind(env.ctx);
    if (waitUntil) {
      waitUntil(
        kvPutWithEviction(kv, mediaUrl, body, { contentType, cached: Date.now() })
      );
    }
  }

  const headers = new Headers(corsHeaders);
  headers.set("Content-Type", contentType);
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  headers.set("X-Cache", "MISS");
  return new Response(body, { status: 200, headers });
}

// ── KV put with eviction (batch deletes with Promise.all) ─
async function kvPutWithEviction(kv, key, value, metadata) {
  const putOpts = { expirationTtl: 172800, metadata };
  try {
    await kv.put(key, value, putOpts);
  } catch (_) {
    try {
      const list = await kv.list({ limit: 100 });
      if (!list.keys || list.keys.length === 0) return;
      const sorted = [...list.keys].sort((a, b) => {
        const aTime = a.metadata?.cached || 0;
        const bTime = b.metadata?.cached || 0;
        return aTime - bTime;
      });
      const toEvict = sorted.slice(0, 5);
      // Batch delete with Promise.all
      await Promise.all(toEvict.map(entry => kv.delete(entry.name)));
      // Retry put
      try {
        await kv.put(key, value, putOpts);
      } catch (_) {
        // Eviction and retry failed, continue silently
      }
    } catch (_) {
      // Eviction failed, continue silently
    }
  }
}

// ── Mirror Registry helpers ───────────────────────────────
async function handleGetMirrors(env, origin, requestId) {
  const corsHeaders = getCorsHeaders(origin, env);
  const kv = env.MIRRORS;
  if (!kv) {
    return new Response(JSON.stringify({ mirrors: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json", ...corsHeaders }
    });
  }
  try {
    const list = await kv.list({ limit: 100 });
    const mirrors = [];
    for (const key of list.keys) {
      const val = await kv.get(key.name, { type: "json" });
      if (val && val.url) mirrors.push({
        url: val.url,
        discordReady: val.discordReady ?? true,
        instagramReady: val.instagramReady ?? true,
      });
    }
    return new Response(JSON.stringify({ mirrors }), {
      status: 200,
      headers: { "Content-Type": "application/json", ...corsHeaders }
    });
  } catch (err) {
    return errJson(500, "Failed to list mirrors", requestId, origin, env);
  }
}

async function handleRegisterMirror(request, env, origin, requestId) {
  let body;
  try {
    body = await request.json();
  } catch {
    return errJson(400, "Invalid JSON body", requestId, origin, env);
  }

  const { url, secret } = body;
  if (!secret || secret !== env.MIRROR_SECRET) {
    return errJson(403, "Invalid mirror secret", requestId, origin, env);
  }

  if (!url || typeof url !== "string") {
    return errJson(400, "Missing or invalid url", requestId, origin, env);
  }

  // Validate URL format: must be HTTPS or ngrok
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    return errJson(400, "Invalid URL format", requestId, origin, env);
  }

  if (parsedUrl.protocol !== "https:" && !parsedUrl.hostname.endsWith(".ngrok-free.app") && !parsedUrl.hostname.endsWith(".ngrok.io")) {
    return errJson(400, "URL must be HTTPS or ngrok", requestId, origin, env);
  }

  // Health check: fetch /status with 5s timeout
  let statusData = {};
  try {
    const statusUrl = url.replace(/\/+$/, "") + "/status";
    const resp = await fetch(statusUrl, { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) {
      return errJson(502, "Mirror health check failed: HTTP " + resp.status, requestId, origin, env);
    }
    try { statusData = await resp.json(); } catch { /* ignore parse errors */ }
  } catch (err) {
    return errJson(502, "Mirror health check failed: " + (err.message || "timeout"), requestId, origin, env);
  }

  // Store in MIRRORS KV with 1-hour TTL
  const kv = env.MIRRORS;
  if (!kv) {
    return errJson(500, "MIRRORS KV namespace not bound", requestId, origin, env);
  }

  const kvKey = parsedUrl.host + parsedUrl.pathname;
  const entry = {
    url: url,
    registeredAt: new Date().toISOString(),
    discordReady: !!(statusData.ok && (statusData.discord?.ready || statusData.discord?.hasCachedToken)),
    instagramReady: !!(statusData.ok && (statusData.instagram?.ready || statusData.instagram?.hasCachedSession)),
  };

  try {
    await kv.put(kvKey, JSON.stringify(entry), { expirationTtl: 3600 });
  } catch (err) {
    return errJson(500, "Failed to register mirror", requestId, origin, env);
  }

  const corsHeaders = getCorsHeaders(origin, env);
  return new Response(JSON.stringify({ ok: true }), {
    status: 201,
    headers: { "Content-Type": "application/json", ...corsHeaders }
  });
}

async function handleDeleteMirror(request, env, origin, requestId) {
  let body;
  try {
    body = await request.json();
  } catch {
    return errJson(400, "Invalid JSON body", requestId, origin, env);
  }

  const { url, secret } = body;
  if (!secret || secret !== env.MIRROR_SECRET) {
    return errJson(403, "Invalid mirror secret", requestId, origin, env);
  }

  if (!url || typeof url !== "string") {
    return errJson(400, "Missing or invalid url", requestId, origin, env);
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    return errJson(400, "Invalid URL format", requestId, origin, env);
  }

  const kv = env.MIRRORS;
  if (!kv) {
    return errJson(500, "MIRRORS KV namespace not bound", requestId, origin, env);
  }

  const kvKey = parsedUrl.host + parsedUrl.pathname;
  try {
    await kv.delete(kvKey);
  } catch (err) {
    return errJson(500, "Failed to delete mirror", requestId, origin, env);
  }

  const corsHeaders = getCorsHeaders(origin, env);
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json", ...corsHeaders }
  });
}

async function handleContributeMirror(request, env, origin, requestId) {
  let body;
  try {
    body = await request.json();
  } catch {
    return errJson(400, "Invalid JSON body", requestId, origin, env);
  }

  const { url } = body;
  if (!url || typeof url !== "string") {
    return errJson(400, "Missing or invalid url", requestId, origin, env);
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    return errJson(400, "Invalid URL format", requestId, origin, env);
  }

  if (parsedUrl.protocol !== "https:" && !parsedUrl.hostname.endsWith(".ngrok-free.app") && !parsedUrl.hostname.endsWith(".ngrok.io")) {
    return errJson(400, "URL must be HTTPS or ngrok", requestId, origin, env);
  }

  // Health check
  let statusData = {};
  try {
    const statusUrl = url.replace(/\/+$/, "") + "/status";
    const resp = await fetch(statusUrl, { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) {
      return errJson(502, "Mirror health check failed: HTTP " + resp.status, requestId, origin, env);
    }
    try { statusData = await resp.json(); } catch { /* ignore parse errors */ }
  } catch (err) {
    return errJson(502, "Mirror health check failed: " + (err.message || "timeout"), requestId, origin, env);
  }

  const kv = env.MIRRORS;
  if (!kv) {
    return errJson(500, "MIRRORS KV namespace not bound", requestId, origin, env);
  }

  const kvKey = parsedUrl.host + parsedUrl.pathname;
  const entry = {
    url: url,
    registeredAt: new Date().toISOString(),
    contributed: true,
    discordReady: !!(statusData.ok && (statusData.discord?.ready || statusData.discord?.hasCachedToken)),
    instagramReady: !!(statusData.ok && (statusData.instagram?.ready || statusData.instagram?.hasCachedSession)),
  };

  try {
    await kv.put(kvKey, JSON.stringify(entry), { expirationTtl: 1800 });
  } catch (err) {
    return errJson(500, "Failed to register mirror", requestId, origin, env);
  }

  const corsHeaders = getCorsHeaders(origin, env);
  return new Response(JSON.stringify({ ok: true }), {
    status: 201,
    headers: { "Content-Type": "application/json", ...corsHeaders }
  });
}

// ── Main worker ───────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    const requestId = crypto.randomUUID();
    const origin = request.headers.get("Origin") || null;

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: getCorsHeaders(origin, env) });
    }

    // ── Request body size limit ────────────────────────────
    if (checkBodySize(request)) {
      return errJson(413, "Request body too large (max 10MB)", requestId, origin, env);
    }

    const ip = request.headers.get("cf-connecting-ip") || "unknown";
    const url = new URL(request.url);

    // ── /pubkey endpoint ──────────────────────────────────
    if (url.pathname === "/pubkey" && request.method === "GET") {
      try {
        const privateKey = await importECDHPrivateKey(env.WORKER_ECDH_PRIVATE);
        const publicJwk = await getWorkerPublicJwk(privateKey);
        return new Response(JSON.stringify(publicJwk), {
          status: 200,
          headers: { "Content-Type": "application/json", ...getCorsHeaders(origin, env) }
        });
      } catch (err) {
        return errJson(500, "Failed to export public key", requestId, origin, env);
      }
    }

    // ── /register endpoint ────────────────────────────────
    if (url.pathname === "/register" && request.method === "POST") {
      const rl = checkRateLimit(ip, "register");
      if (rl > 0) return rateLimitResponse(rl, origin, env, requestId);

      try {
        const body = await request.json();
        const { clientId, publicKey, service: svc } = body;
        if (!clientId || !publicKey) {
          return errJson(400, "Missing clientId or publicKey", requestId, origin, env);
        }

        // Validate clientId format
        if (!validateClientId(clientId)) {
          return errJson(400, "Invalid clientId: must be alphanumeric/hyphens, 1-64 chars", requestId, origin, env);
        }

        // Validate publicKey JWK structure
        if (!validatePublicKeyJwk(publicKey)) {
          return errJson(400, "Invalid publicKey: must be a P-256 EC JWK with kty, crv, x, y", requestId, origin, env);
        }

        const kv = env.CLIENTS;
        if (!kv) {
          return errJson(500, "CLIENTS KV namespace not bound", requestId, origin, env);
        }

        // Store with service prefix only
        const kvKey = (svc || "discord") + ":" + clientId;
        await kv.put(kvKey, JSON.stringify(publicKey));

        // Generate and store random HKDF salt for this client
        const salt = generateSalt();
        await storeClientSalt(kv, kvKey, salt);

        // Generate verification challenge
        const privateKey = await importECDHPrivateKey(env.WORKER_ECDH_PRIVATE);
        const deriveSvc = svc || "discord";
        const aesKey = await getSharedAESKey(privateKey, publicKey, deriveSvc, salt);
        const nonce = crypto.getRandomValues(new Uint8Array(32));
        const nonceHex = Array.from(nonce).map((b) => b.toString(16).padStart(2, "0")).join("");
        const encryptedChallenge = await encryptPayload(aesKey, JSON.stringify({ nonce: nonceHex, timestamp: Date.now() }));

        return new Response(JSON.stringify({ ok: true, challenge: encryptedChallenge }), {
          status: 200,
          headers: { "Content-Type": "application/json", ...getCorsHeaders(origin, env) }
        });
      } catch (err) {
        return errJson(400, "Invalid registration payload", requestId, origin, env);
      }
    }

    // ── /mirrors endpoints ────────────────────────────────
    if (url.pathname === "/mirrors" || url.pathname === "/mirrors/") {
      if (request.method === "GET") {
        return handleGetMirrors(env, origin, requestId);
      }
      if (request.method === "POST") {
        return errJson(405, "Use POST /mirrors/register", requestId, origin, env);
      }
      if (request.method === "DELETE") {
        const rl = checkRateLimit(ip, "mirrors");
        if (rl > 0) return rateLimitResponse(rl, origin, env, requestId);
        return handleDeleteMirror(request, env, origin, requestId);
      }
    }

    if (url.pathname === "/mirrors/register" && request.method === "POST") {
      const rl = checkRateLimit(ip, "mirrors");
      if (rl > 0) return rateLimitResponse(rl, origin, env, requestId);
      return handleRegisterMirror(request, env, origin, requestId);
    }

    if (url.pathname === "/mirrors/contribute" && request.method === "POST") {
      const rl = checkRateLimit(ip, "mirrors");
      if (rl > 0) return rateLimitResponse(rl, origin, env, requestId);
      return handleContributeMirror(request, env, origin, requestId);
    }

    // ── /image endpoint ───────────────────────────────────
    if (url.pathname === "/image") {
      const rl = checkRateLimit(ip, "image");
      if (rl > 0) return rateLimitResponse(rl, origin, env, requestId);
      return handleImageRequest(request, env, ctx, origin, requestId);
    }

    // ── General CORS proxy ────────────────────────────────
    const rl = checkRateLimit(ip, "proxy");
    if (rl > 0) return rateLimitResponse(rl, origin, env, requestId);

    let target = url.pathname.slice(1) + url.search;
    target = target.replace(/^(https?:\/)([^/])/, "$1/$2");
    if (!target || !/^https?:\/\//i.test(target)) {
      return errJson(400, "Missing or invalid target URL", requestId, origin, env);
    }
    let targetUrl;
    try {
      targetUrl = new URL(target);
    } catch {
      return errJson(400, "Malformed target URL", requestId, origin, env);
    }

    // ── Domain allowlist check ────────────────────────────
    const service = getService(targetUrl.hostname);
    if (!service) {
      return errJson(403, "Domain not allowed", requestId, origin, env);
    }

    // ── Encrypted auth header handling ───────────────────
    const encryptedAuth = request.headers.get("X-Encrypted-Auth");
    const clientId = request.headers.get("X-Client-Id");
    let decryptedAuthPayload = null;
    let aesKeyForResponse = null;

    if (encryptedAuth && clientId) {
      try {
        const clientsKv = env.CLIENTS;
        if (!clientsKv) {
          return errJson(500, "CLIENTS KV namespace not bound", requestId, origin, env);
        }
        // Only look up service-prefixed key (no unprefixed fallback)
        const kvKey = service + ":" + clientId;
        const clientPubKeyJson = await clientsKv.get(kvKey);
        if (!clientPubKeyJson) {
          return errJson(401, "Unknown client ID", requestId, origin, env);
        }

        // Retrieve per-client salt
        const salt = await getClientSalt(clientsKv, kvKey);
        if (!salt) {
          return errJson(401, "Client salt not found; re-register required", requestId, origin, env);
        }

        const clientPubKey = JSON.parse(clientPubKeyJson);
        const privateKey = await importECDHPrivateKey(env.WORKER_ECDH_PRIVATE);
        aesKeyForResponse = await getSharedAESKey(privateKey, clientPubKey, service, salt);

        const decryptedJson = await decryptPayload(aesKeyForResponse, encryptedAuth);
        decryptedAuthPayload = JSON.parse(decryptedJson);

        // Replay protection: reject if timestamp > 60s old
        const now = Date.now();
        if (!decryptedAuthPayload.timestamp || Math.abs(now - decryptedAuthPayload.timestamp) > 60000) {
          return errJson(401, "Auth payload expired or invalid timestamp", requestId, origin, env);
        }

        // Nonce replay protection
        if (!decryptedAuthPayload.nonce || typeof decryptedAuthPayload.nonce !== "string") {
          return errJson(401, "Missing nonce in auth payload", requestId, origin, env);
        }
        const noncesKv = env.NONCES;
        if (noncesKv) {
          const nonceKey = "nonce:" + decryptedAuthPayload.nonce;
          const existing = await noncesKv.get(nonceKey);
          if (existing) {
            return errJson(401, "Duplicate nonce (replay detected)", requestId, origin, env);
          }
          // Store nonce with 120s TTL
          await noncesKv.put(nonceKey, "1", { expirationTtl: 120 });
        }
      } catch (err) {
        return errJson(401, "Failed to decrypt auth payload", requestId, origin, env);
      }
    } else if (clientId && !encryptedAuth) {
      try {
        const clientsKv = env.CLIENTS;
        if (clientsKv) {
          // Only service-prefixed key (no unprefixed fallback)
          const kvKey = service + ":" + clientId;
          const clientPubKeyJson = await clientsKv.get(kvKey);
          if (clientPubKeyJson) {
            const salt = await getClientSalt(clientsKv, kvKey);
            if (salt) {
              const clientPubKey = JSON.parse(clientPubKeyJson);
              const privateKey = await importECDHPrivateKey(env.WORKER_ECDH_PRIVATE);
              aesKeyForResponse = await getSharedAESKey(privateKey, clientPubKey, service, salt);
            }
          }
        }
      } catch (_) {
        // Fall through without response encryption
      }
    }

    const out = new Headers();
    let igSession = null, igCsrf = null, igFullCookie = null;
    for (const [key, value] of request.headers.entries()) {
      const lower = key.toLowerCase();
      if (lower === "host" || lower === "mediaurl" || lower.startsWith("cf-")
          || lower === "x-encrypted-auth" || lower === "x-client-id")
        continue;
      if (lower === "x-ig-session")     { igSession = value; continue; }
      if (lower === "x-ig-csrf")        { igCsrf = value;    continue; }
      if (lower === "x-ig-full-cookie") { igFullCookie = value; continue; }
      out.set(key, value);
    }
    out.set("Host", targetUrl.host);
    out.set("Origin", targetUrl.origin);
    out.set("Referer", targetUrl.origin + "/");

    // ── Apply decrypted auth per service ──────────────────
    if (decryptedAuthPayload) {
      if (service === "discord") {
        if (decryptedAuthPayload.auth) {
          out.set("Authorization", decryptedAuthPayload.auth);
        }
      } else if (service === "instagram") {
        if (decryptedAuthPayload.cookie) {
          out.set("Cookie", decryptedAuthPayload.cookie);
        }
        if (decryptedAuthPayload.csrfToken) {
          out.set("X-CSRFToken", decryptedAuthPayload.csrfToken);
        }
      }
    } else if (service === "instagram") {
      // Prefer full cookies from Playwright session (includes all auth cookies)
      if (igFullCookie) {
        out.set("Cookie", igFullCookie);
      } else if (igSession) {
        out.set("Cookie", `sessionid=${igSession}; csrftoken=${igCsrf || ""}`);
      }
    }

    if (!out.has("User-Agent")) {
      out.set("User-Agent", USER_AGENTS[service] || USER_AGENTS.discord);
    }
    if (!out.has("Accept")) {
      out.set("Accept", "*/*");
    }
    const init = {
      method: request.method,
      headers: out,
      redirect: "follow",
      signal: AbortSignal.timeout(15000)
    };
    if (request.method !== "GET" && request.method !== "HEAD") {
      init.body = request.body;
      init.duplex = "half";
    }
    let upstream;
    try {
      upstream = await fetch(targetUrl.toString(), init);
    } catch (err) {
      return errJson(502, "Upstream fetch failed", requestId, origin, env);
    }

    const corsHeaders = getCorsHeaders(origin, env);
    const resHeaders = new Headers(corsHeaders);
    for (const [key, value] of upstream.headers.entries()) {
      if (BLOCKED_RESPONSE_HEADERS.has(key.toLowerCase()))
        continue;
      resHeaders.append(key, value);
    }

    // ── Encrypt response body if client registered ───────
    if (aesKeyForResponse) {
      try {
        const bodyBuffer = await upstream.arrayBuffer();
        const encryptedBody = await encryptPayload(aesKeyForResponse, bodyBuffer);
        resHeaders.set("X-Encrypted-Body", "1");
        return new Response(encryptedBody, {
          status: upstream.status,
          statusText: upstream.statusText,
          headers: resHeaders
        });
      } catch (encErr) {
        // Never silently fall back to unencrypted — return error
        return errJson(500, "Response encryption failed", requestId, origin, env);
      }
    }

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: resHeaders
    });
  }
};
