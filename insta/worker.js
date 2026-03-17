var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/worker.js

// ── Allowed domains (SSRF prevention) ─────────────────────
var ALLOWED_HOSTS = /* @__PURE__ */ new Set([
  "i.instagram.com",
  "www.instagram.com",
  "instagram.com",
  "graph.instagram.com",
  "scontent.cdninstagram.com"
]);

function isAllowedHost(hostname) {
  if (ALLOWED_HOSTS.has(hostname)) return true;
  // Allow all cdninstagram.com subdomains (scontent-lax3-1.cdninstagram.com, etc.)
  if (hostname.endsWith(".cdninstagram.com")) return true;
  // Allow subdomains of allowed hosts
  for (const h of ALLOWED_HOSTS) {
    if (hostname.endsWith("." + h)) return true;
  }
  return false;
}
__name(isAllowedHost, "isAllowedHost");

var CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, Cookie, X-CSRFToken, X-IG-App-ID, mediaurl",
  "Access-Control-Expose-Headers": "Content-Type, Content-Length, X-Cache, Set-Cookie",
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
var worker_default = {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }
    const url = new URL(request.url);

    // ── /image endpoint: fetch & cache media via KV ──────
    if (url.pathname === "/image") {
      return handleImageRequest(request, env);
    }

    // ── General CORS proxy ───────────────────────────────
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
    if (!isAllowedHost(targetUrl.hostname)) {
      return errJson(403, "Domain not allowed");
    }

    const out = new Headers();
    for (const [key, value] of request.headers.entries()) {
      const lower = key.toLowerCase();
      if (lower === "host" || lower === "mediaurl" || lower.startsWith("cf-"))
        continue;
      out.set(key, value);
    }
    out.set("Host", targetUrl.host);
    out.set("Origin", targetUrl.origin);
    out.set("Referer", targetUrl.origin + "/");
    if (!out.has("User-Agent")) {
      out.set(
        "User-Agent",
        "Instagram 275.0.0.27.98 Android (33/13; 420dpi; 1080x2400; samsung; SM-G991B; o1s; exynos2100; en_US; 458229258)"
      );
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
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: resHeaders
    });
  }
};

// ── Image handler with KV caching ────────────────────────
async function handleImageRequest(request, env) {
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
  if (!isAllowedHost(parsedUrl.hostname)) {
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

  // Fetch the image from upstream
  let upstream;
  try {
    upstream = await fetch(parsedUrl.toString(), {
      headers: {
        "User-Agent": "Instagram 275.0.0.27.98 Android (33/13; 420dpi; 1080x2400; samsung; SM-G991B; o1s; exynos2100; en_US; 458229258)",
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
    env.ctx?.waitUntil?.(
      kvPutWithEviction(kv, mediaUrl, body, { contentType, cached: Date.now() })
    );
  }

  const headers = new Headers(CORS);
  headers.set("Content-Type", contentType);
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  headers.set("X-Cache", "MISS");
  return new Response(body, { status: 200, headers });
}
__name(handleImageRequest, "handleImageRequest");

// ── KV put with eviction on failure ───────────────────────
async function kvPutWithEviction(kv, key, value, metadata) {
  const putOpts = { expirationTtl: 172800, metadata };
  try {
    await kv.put(key, value, putOpts);
  } catch (_) {
    // KV full or write failed — evict oldest or biggest entry and retry
    try {
      const list = await kv.list();
      if (!list.keys || list.keys.length === 0) return;
      // Find the oldest entry (lowest cached timestamp), falling back to biggest
      let evictKey = null;
      let oldestTime = Infinity;
      for (const k of list.keys) {
        const cached = k.metadata?.cached || 0;
        if (cached < oldestTime) {
          oldestTime = cached;
          evictKey = k.name;
        }
      }
      if (evictKey) {
        await kv.delete(evictKey);
        try { await kv.put(key, value, putOpts); } catch (_) { /* give up */ }
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
