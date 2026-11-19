import { timingSafeEqual } from "node:crypto";

const ACCOUNT_ID = "2cc3a4ec0dbc3969ca8c25a0c20a2465";
const GATEWAY_ID = "jugginai";
const GATEWAY_BASE = `https://gateway.ai.cloudflare.com/v1/${ACCOUNT_ID}/${GATEWAY_ID}`;

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
  "authorization",
  "cf-aig-authorization",
]);

function json(status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function route(urlPath) {
  if (urlPath === "/openai" || urlPath.startsWith("/openai/")) {
    return { provider: "openai", rest: urlPath.slice("/openai".length) || "/", keyName: "OPENAI_API_KEY" };
  }
  if (urlPath === "/grok" || urlPath.startsWith("/grok/")) {
    return { provider: "grok", rest: urlPath.slice("/grok".length) || "/", keyName: "XAI_API_KEY" };
  }
  return null;
}

function authorized(header, token) {
  const expected = `Bearer ${token}`;
  const a = Buffer.from(header || "");
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

export default {
  async fetch(request, env) {
    try {
      const token = env.AI_PROXY_TOKEN || "";
      if (!token || !authorized(request.headers.get("authorization"), token)) {
        return json(401, { error: "unauthorized" });
      }
      const url = new URL(request.url);
      const matched = route(url.pathname);
      if (!matched) {
        return json(404, { error: "not found" });
      }
      const providerKey = env[matched.keyName] || "";
      if (!providerKey) {
        return json(500, { error: `missing provider credentials for ${matched.provider}` });
      }
      const cfToken = env.CF_AIG_AUTHORIZATION || "";
      if (!cfToken) {
        return json(500, { error: "missing gateway credentials" });
      }
      const target = `${GATEWAY_BASE}/${matched.provider}${matched.rest}${url.search}`;
      const headers = new Headers();
      headers.set("authorization", `Bearer ${providerKey}`);
      headers.set("cf-aig-authorization", `Bearer ${cfToken}`);
      for (const [k, v] of request.headers.entries()) {
        if (HOP_BY_HOP.has(k.toLowerCase())) continue;
        headers.set(k, v);
      }
      const method = request.method || "GET";
      const hasBody = !["GET", "HEAD"].includes(method);
      const upstream = await fetch(target, {
        method,
        headers,
        body: hasBody ? request.body : undefined,
      });
      const outHeaders = new Headers();
      upstream.headers.forEach((value, key) => {
        if (HOP_BY_HOP.has(key.toLowerCase())) return;
        outHeaders.set(key, value);
      });
      return new Response(upstream.body, {
        status: upstream.status,
        headers: outHeaders,
      });
    } catch (err) {
      console.error("ai-proxy error:", err instanceof Error ? err.message : "request failed");
      return json(502, { error: "upstream error" });
    }
  },
};
