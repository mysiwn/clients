var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/worker.js

// ── Allowed domains (SSRF prevention) ─────────────────────
var ALLOWED_HOSTS = /* @__PURE__ */ new Set([
  "discord.com",
  "cdn.discordapp.com",
  "media.discordapp.net",
  "images-ext-1.discordapp.net",
  "images-ext-2.discordapp.net",
  "gateway.discord.gg"
]);

function isAllowedHost(hostname) {
  if (ALLOWED_HOSTS.has(hostname)) return true;
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
  "Access-Control-Allow-Headers": "Authorization, Content-Type, mediaurl",
  "Access-Control-Expose-Headers": "Content-Type, Content-Length, X-Cache",
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
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36"
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
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
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

  // Store in KV (non-blocking, 2 day TTL)
  if (kv && body.byteLength < 25 * 1024 * 1024) {
    try {
      env.ctx?.waitUntil?.(
        kv.put(mediaUrl, body, {
          expirationTtl: 172800,
          metadata: { contentType, cached: Date.now() }
        })
      );
    } catch (_) {
      // KV write failed, continue serving
    }
  }

  const headers = new Headers(CORS);
  headers.set("Content-Type", contentType);
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  headers.set("X-Cache", "MISS");
  return new Response(body, { status: 200, headers });
}
__name(handleImageRequest, "handleImageRequest");

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
