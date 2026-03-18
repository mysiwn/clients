var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/worker.js — Unified CORS proxy for Discord + Instagram

// ── Allowed domains (SSRF prevention) ─────────────────────
var DISCORD_HOSTS = /* @__PURE__ */ new Set([
  "discord.com",
  "cdn.discordapp.com",
  "media.discordapp.net",
  "images-ext-1.discordapp.net",
  "images-ext-2.discordapp.net",
  "gateway.discord.gg"
]);

var INSTAGRAM_HOSTS = /* @__PURE__ */ new Set([
  "i.instagram.com",
  "www.instagram.com",
  "instagram.com",
  "graph.instagram.com",
  "scontent.cdninstagram.com"
]);

function getService(hostname) {
  if (DISCORD_HOSTS.has(hostname)) return "discord";
  if (INSTAGRAM_HOSTS.has(hostname)) return "instagram";
  // Check subdomains
  for (const h of DISCORD_HOSTS) {
    if (hostname.endsWith("." + h)) return "discord";
  }
  for (const h of INSTAGRAM_HOSTS) {
    if (hostname.endsWith("." + h)) return "instagram";
  }
  // Instagram CDN subdomains (scontent-lax3-1.cdninstagram.com, etc.)
  if (hostname.endsWith(".cdninstagram.com")) return "instagram";
  return null;
}
__name(getService, "getService");

function isAllowedHost(hostname) {
  return getService(hostname) !== null;
}
__name(isAllowedHost, "isAllowedHost");

var CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, Cookie, X-CSRFToken, X-IG-App-ID, mediaurl, X-Encrypted-Auth, X-Client-Id, X-IG-Session, X-IG-Csrf",
  "Access-Control-Expose-Headers": "Content-Type, Content-Length, X-Cache, Set-Cookie, X-Encrypted-Body",
  "Access-Control-Max-Age": "86400"
};
var BLOCKED_RESPONSE_HEADERS = /* @__PURE__ */ new Set([
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
var USER_AGENTS = {
  discord: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
  instagram: "Instagram 275.0.0.27.98 Android (33/13; 420dpi; 1080x2400; samsung; SM-G991B; o1s; exynos2100; en_US; 458229258)"
};

// ── Rate limiting (in-memory per-isolate) ─────────────────
var rateLimitMap = /* @__PURE__ */ new Map();

var RATE_LIMITS = {
  proxy: { max: 120, windowMs: 60000 },
  image: { max: 30, windowMs: 60000 },
  register: { max: 5, windowMs: 60000 }
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
  // Periodic cleanup: remove stale entries
  if (rateLimitMap.size > 10000) {
    for (const [k, v] of rateLimitMap) {
      if ((now - v.windowStart) > limit.windowMs) {
        rateLimitMap.delete(k);
      }
    }
  }
  return 0;
}
__name(checkRateLimit, "checkRateLimit");

function rateLimitResponse(retryAfter) {
  return new Response(JSON.stringify({ error: "Rate limit exceeded" }), {
    status: 429,
    headers: {
      "Content-Type": "application/json",
      "Retry-After": String(retryAfter),
      ...CORS
    }
  });
}
__name(rateLimitResponse, "rateLimitResponse");

// ── ECDH / Crypto helpers ─────────────────────────────────
var sharedSecretCache = /* @__PURE__ */ new Map();

async function importECDHPrivateKey(jwkJson) {
  const jwk = typeof jwkJson === "string" ? JSON.parse(jwkJson) : jwkJson;
  return crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveKey", "deriveBits"]
  );
}
__name(importECDHPrivateKey, "importECDHPrivateKey");

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
__name(importECDHPublicKey, "importECDHPublicKey");

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
__name(deriveSharedKey, "deriveSharedKey");

async function deriveAESKey(hkdfKey, service) {
  const info = service === "instagram" ? "insta-cors-proxy-e2e" : "discord-cors-proxy-e2e";
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(32),
      info: new TextEncoder().encode(info)
    },
    hkdfKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}
__name(deriveAESKey, "deriveAESKey");

async function getSharedAESKey(privateKey, clientPublicKeyJwk, service) {
  const cacheKey = JSON.stringify(clientPublicKeyJwk) + ":" + service;
  if (sharedSecretCache.has(cacheKey)) {
    return sharedSecretCache.get(cacheKey);
  }
  const pubKey = await importECDHPublicKey(clientPublicKeyJwk);
  const hkdfKey = await deriveSharedKey(privateKey, pubKey);
  const aesKey = await deriveAESKey(hkdfKey, service);
  sharedSecretCache.set(cacheKey, aesKey);
  return aesKey;
}
__name(getSharedAESKey, "getSharedAESKey");

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
__name(encryptPayload, "encryptPayload");

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
__name(decryptPayload, "decryptPayload");

async function getWorkerPublicJwk(privateKey) {
  const fullJwk = await crypto.subtle.exportKey("jwk", privateKey);
  return {
    kty: fullJwk.kty,
    crv: fullJwk.crv,
    x: fullJwk.x,
    y: fullJwk.y
  };
}
__name(getWorkerPublicJwk, "getWorkerPublicJwk");

// ── Main worker ───────────────────────────────────────────
var worker_default = {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    const ip = request.headers.get("cf-connecting-ip") || "unknown";
    const url = new URL(request.url);

    // ── /pubkey endpoint: return worker's ECDH public key ──
    if (url.pathname === "/pubkey" && request.method === "GET") {
      try {
        const privateKey = await importECDHPrivateKey(env.WORKER_ECDH_PRIVATE);
        const publicJwk = await getWorkerPublicJwk(privateKey);
        return new Response(JSON.stringify(publicJwk), {
          status: 200,
          headers: { "Content-Type": "application/json", ...CORS }
        });
      } catch (err) {
        return errJson(500, "Failed to export public key");
      }
    }

    // ── /register endpoint: register a client's public key ─
    if (url.pathname === "/register" && request.method === "POST") {
      const rl = checkRateLimit(ip, "register");
      if (rl > 0) return rateLimitResponse(rl);

      try {
        const body = await request.json();
        const { clientId, publicKey, service: svc } = body;
        if (!clientId || !publicKey) {
          return errJson(400, "Missing clientId or publicKey");
        }

        const kv = env.CLIENTS;
        if (!kv) {
          return errJson(500, "CLIENTS KV namespace not bound");
        }

        // Store client's public key in KV with service prefix
        const kvKey = svc ? svc + ":" + clientId : clientId;
        await kv.put(kvKey, JSON.stringify(publicKey));

        // Generate verification challenge
        const privateKey = await importECDHPrivateKey(env.WORKER_ECDH_PRIVATE);
        const deriveSvc = svc || "discord";
        const aesKey = await getSharedAESKey(privateKey, publicKey, deriveSvc);
        const nonce = crypto.getRandomValues(new Uint8Array(32));
        const nonceHex = Array.from(nonce).map((b) => b.toString(16).padStart(2, "0")).join("");
        const encryptedChallenge = await encryptPayload(aesKey, JSON.stringify({ nonce: nonceHex, timestamp: Date.now() }));

        return new Response(JSON.stringify({ ok: true, challenge: encryptedChallenge }), {
          status: 200,
          headers: { "Content-Type": "application/json", ...CORS }
        });
      } catch (err) {
        return errJson(400, "Invalid registration payload");
      }
    }

    // ── /image endpoint: fetch & cache media via KV ──────
    if (url.pathname === "/image") {
      const rl = checkRateLimit(ip, "image");
      if (rl > 0) return rateLimitResponse(rl);
      return handleImageRequest(request, env, ctx);
    }

    // ── General CORS proxy ───────────────────────────────
    const rl = checkRateLimit(ip, "proxy");
    if (rl > 0) return rateLimitResponse(rl);

    let target = url.pathname.slice(1) + url.search;
    target = target.replace(/^(https?:\/)([^/])/, "$1/$2");
    if (!target || !/^https?:\/\//i.test(target)) {
      return errJson(400, "Missing or invalid target URL");
    }
    let targetUrl;
    try {
      targetUrl = new URL(target);
    } catch {
      return errJson(400, "Malformed target URL");
    }

    // ── Domain allowlist check ────────────────────────────
    const service = getService(targetUrl.hostname);
    if (!service) {
      return errJson(403, "Domain not allowed");
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
          return errJson(500, "CLIENTS KV namespace not bound");
        }
        // Try service-prefixed key first, then fall back to unprefixed
        let clientPubKeyJson = await clientsKv.get(service + ":" + clientId);
        if (!clientPubKeyJson) {
          clientPubKeyJson = await clientsKv.get(clientId);
        }
        if (!clientPubKeyJson) {
          return errJson(401, "Unknown client ID");
        }
        const clientPubKey = JSON.parse(clientPubKeyJson);
        const privateKey = await importECDHPrivateKey(env.WORKER_ECDH_PRIVATE);
        aesKeyForResponse = await getSharedAESKey(privateKey, clientPubKey, service);

        const decryptedJson = await decryptPayload(aesKeyForResponse, encryptedAuth);
        decryptedAuthPayload = JSON.parse(decryptedJson);

        // Replay protection: reject if timestamp > 60s old
        const now = Date.now();
        if (!decryptedAuthPayload.timestamp || Math.abs(now - decryptedAuthPayload.timestamp) > 60000) {
          return errJson(401, "Auth payload expired or invalid timestamp");
        }
      } catch (err) {
        return errJson(401, "Failed to decrypt auth payload");
      }
    } else if (clientId && !encryptedAuth) {
      try {
        const clientsKv = env.CLIENTS;
        if (clientsKv) {
          let clientPubKeyJson = await clientsKv.get(service + ":" + clientId);
          if (!clientPubKeyJson) {
            clientPubKeyJson = await clientsKv.get(clientId);
          }
          if (clientPubKeyJson) {
            const clientPubKey = JSON.parse(clientPubKeyJson);
            const privateKey = await importECDHPrivateKey(env.WORKER_ECDH_PRIVATE);
            aesKeyForResponse = await getSharedAESKey(privateKey, clientPubKey, service);
          }
        }
      } catch (_) {
        // Fall through without response encryption
      }
    }

    const out = new Headers();
    let igSession = null, igCsrf = null;
    for (const [key, value] of request.headers.entries()) {
      const lower = key.toLowerCase();
      if (lower === "host" || lower === "mediaurl" || lower.startsWith("cf-")
          || lower === "x-encrypted-auth" || lower === "x-client-id")
        continue;
      if (lower === "x-ig-session") { igSession = value; continue; }
      if (lower === "x-ig-csrf")    { igCsrf = value;    continue; }
      out.set(key, value);
    }
    out.set("Host", targetUrl.host);
    out.set("Origin", targetUrl.origin);
    out.set("Referer", targetUrl.origin + "/");

    // ── Apply decrypted auth per service ──────────────────
    if (decryptedAuthPayload) {
      if (service === "discord") {
        // Discord: set Authorization header
        if (decryptedAuthPayload.auth) {
          out.set("Authorization", decryptedAuthPayload.auth);
        }
      } else if (service === "instagram") {
        // Instagram: set Cookie + X-CSRFToken
        if (decryptedAuthPayload.cookie) {
          out.set("Cookie", decryptedAuthPayload.cookie);
        }
        if (decryptedAuthPayload.csrfToken) {
          out.set("X-CSRFToken", decryptedAuthPayload.csrfToken);
        }
      }
    } else if (service === "instagram" && igSession) {
      // Plain-header path: browsers can't set Cookie directly, so we accept
      // X-IG-Session / X-IG-Csrf and reconstruct the Cookie here
      out.set("Cookie", `sessionid=${igSession}; csrftoken=${igCsrf || ""}`);
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
      redirect: "follow"
    };
    if (request.method !== "GET" && request.method !== "HEAD") {
      init.body = request.body;
      init.duplex = "half";
    }
    let upstream;
    try {
      upstream = await fetch(targetUrl.toString(), init);
    } catch (err) {
      return errJson(502, "Upstream fetch failed");
    }
    const resHeaders = new Headers(CORS);
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
      } catch (_) {
        // If encryption fails, fall through to unencrypted
      }
    }

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: resHeaders
    });
  }
};

// ── Image handler with KV caching ────────────────────────
async function handleImageRequest(request, env, ctx) {
  const mediaUrl = request.headers.get("mediaurl");
  if (!mediaUrl) {
    return errJson(400, "Missing 'mediaurl' header");
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(mediaUrl);
  } catch {
    return errJson(400, "Invalid media URL");
  }

  // ── Domain allowlist check ────────────────────────────
  const service = getService(parsedUrl.hostname);
  if (!service) {
    return errJson(403, "Media domain not allowed");
  }

  const kv = env.IMAGE_CACHE;

  // Try KV cache first (if KV binding exists)
  if (kv) {
    try {
      const { value, metadata } = await kv.getWithMetadata(mediaUrl, { type: "arrayBuffer" });
      if (value) {
        const headers = new Headers(CORS);
        headers.set("Content-Type", metadata?.contentType || "application/octet-stream");
        headers.set("Cache-Control", "public, max-age=31536000, immutable");
        headers.set("X-Cache", "HIT");
        return new Response(value, { status: 200, headers });
      }
    } catch (_) {
      // KV read failed, fall through to fetch
    }
  }

  // Fetch the image from upstream with service-appropriate user agent
  let upstream;
  try {
    upstream = await fetch(parsedUrl.toString(), {
      headers: {
        "User-Agent": USER_AGENTS[service] || USER_AGENTS.discord,
        "Accept": "image/*,*/*;q=0.8",
        "Referer": parsedUrl.origin + "/"
      },
      redirect: "follow"
    });
  } catch (err) {
    return errJson(502, "Upstream fetch failed");
  }

  if (!upstream.ok) {
    return errJson(upstream.status, "Upstream error");
  }

  const contentType = upstream.headers.get("content-type") || "application/octet-stream";
  const body = await upstream.arrayBuffer();

  // Store in KV (non-blocking, 2 day TTL) with eviction on failure
  if (kv && body.byteLength < 25 * 1024 * 1024) {
    const waitUntil = ctx?.waitUntil?.bind(ctx) || env.ctx?.waitUntil?.bind(env.ctx);
    if (waitUntil) {
      waitUntil(
        kvPutWithEviction(kv, mediaUrl, body, { contentType, cached: Date.now() })
      );
    }
  }

  const headers = new Headers(CORS);
  headers.set("Content-Type", contentType);
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  headers.set("X-Cache", "MISS");
  return new Response(body, { status: 200, headers });
}
__name(handleImageRequest, "handleImageRequest");

// ── KV put with eviction on failure (evict up to 5) ──────
async function kvPutWithEviction(kv, key, value, metadata) {
  const putOpts = { expirationTtl: 172800, metadata };
  try {
    await kv.put(key, value, putOpts);
  } catch (_) {
    // KV full or write failed — evict up to 5 oldest entries and retry
    try {
      const list = await kv.list();
      if (!list.keys || list.keys.length === 0) return;
      const sorted = [...list.keys].sort((a, b) => {
        const aTime = a.metadata?.cached || 0;
        const bTime = b.metadata?.cached || 0;
        return aTime - bTime;
      });
      const toEvict = sorted.slice(0, 5);
      for (const entry of toEvict) {
        await kv.delete(entry.name);
        try {
          await kv.put(key, value, putOpts);
          return;
        } catch (_) {
          // Continue evicting
        }
      }
    } catch (_) {
      // Eviction failed, continue silently
    }
  }
}
__name(kvPutWithEviction, "kvPutWithEviction");

function errJson(status, message) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json", ...CORS }
  });
}
__name(errJson, "errJson");
export {
  worker_default as default
};
