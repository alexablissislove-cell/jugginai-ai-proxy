import { timingSafeEqual } from "node:crypto";

export const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te",
  "trailers", "transfer-encoding", "upgrade", "host", "content-length",
  "authorization", "cf-aig-authorization", "cookie", "x-api-key",
]);

export function json(status, obj, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", ...extraHeaders },
  });
}

export function notConfigured(name, keyName) {
  return json(503, { error: { type: "not_configured", message: `${name} is not configured`, missing: keyName } });
}

export function authorized(header, token) {
  const expected = `Bearer ${token}`;
  const a = Buffer.from(header || "");
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

export function copyResponseHeaders(upstream, extra = {}) {
  const out = new Headers();
  upstream.headers.forEach((value, key) => {
    const k = key.toLowerCase();
    if (HOP_BY_HOP.has(k) || k === "set-cookie" || k === "content-encoding") return;
    out.set(key, value);
  });
  for (const [k, v] of Object.entries(extra)) out.set(k, v);
  return out;
}

// Timeout that only covers getting response headers, so long streams are not cut off.
export async function fetchWithHeaderTimeout(url, init = {}, ms = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("timeout"), ms);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

export function badRequest(message) {
  return json(400, { error: { type: "invalid_request_error", message } });
}
