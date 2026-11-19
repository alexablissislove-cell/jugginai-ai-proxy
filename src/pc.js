import { json, fetchWithHeaderTimeout, copyResponseHeaders, HOP_BY_HOP } from "./util.js";
import { pcBridgeUrl } from "./providers.js";

// Cloudflare tunnel/origin-down statuses that mean the PC itself is unreachable.
const OFFLINE_STATUSES = new Set([502, 503, 504, 521, 522, 523, 524, 530]);

export function pcOffline(reason) {
  return json(503, { error: { type: "pc_offline", message: "PC bridge is offline or unreachable", reason } });
}

export async function pcFetch(env, path, init = {}, timeoutMs = 15000) {
  if (!env.PC_BRIDGE_TOKEN) return { offline: true, reason: "PC_BRIDGE_TOKEN not configured" };
  const headers = new Headers(init.headers || {});
  headers.set("authorization", `Bearer ${env.PC_BRIDGE_TOKEN}`);
  try {
    const res = await fetchWithHeaderTimeout(`${pcBridgeUrl(env)}${path}`, { ...init, headers }, timeoutMs);
    const isCfError = OFFLINE_STATUSES.has(res.status) && (res.headers.get("content-type") || "").includes("text/html");
    if (isCfError || res.status === 530) return { offline: true, reason: `bridge returned ${res.status}`, response: res };
    return { response: res };
  } catch (err) {
    return { offline: true, reason: err === "timeout" || err?.name === "AbortError" ? "timeout" : "network error" };
  }
}

// ALL /v1/pc/* -> {PC_BRIDGE_URL}/*
export async function handlePcPassthrough(request, env, rest, search) {
  const headers = new Headers();
  for (const [k, v] of request.headers.entries()) {
    if (HOP_BY_HOP.has(k.toLowerCase())) continue;
    headers.set(k, v);
  }
  const method = request.method;
  const hasBody = !["GET", "HEAD"].includes(method);
  const r = await pcFetch(env, `${rest}${search}`, { method, headers, body: hasBody ? request.body : undefined });
  if (r.offline) {
    return pcOffline(r.reason);
  }
  return new Response(r.response.body, { status: r.response.status, headers: copyResponseHeaders(r.response, { "x-jugginai-provider": "pc-bridge" }) });
}

// Normalize whatever shape /models/installed returns into [{ id, engine, loaded, kind }].
export function normalizeInstalled(body) {
  const out = [];
  const push = (m, engineHint) => {
    if (!m) return;
    if (typeof m === "string") m = { id: m };
    const engineRaw = String(m.engine || m.backend || engineHint || "").toLowerCase();
    const engine = engineRaw.includes("llama") ? "llamacpp" : engineRaw.includes("lm") ? "lmstudio" : engineHint || "lmstudio";
    const id = m.id || m.modelKey || m.model_key || m.name || m.path || m.file;
    if (!id) return;
    const kind = m.type || m.kind || (/embed/i.test(id) ? "embedding" : "chat");
    const loaded = Boolean(m.loaded ?? m.isLoaded ?? m.state === "loaded" ?? false);
    out.push({ id: String(id), engine, loaded, kind });
  };
  if (Array.isArray(body)) body.forEach((m) => push(m));
  else if (body && typeof body === "object") {
    for (const key of ["models", "data", "installed"]) if (Array.isArray(body[key])) body[key].forEach((m) => push(m));
    for (const key of ["lmstudio", "llamacpp", "llama_cpp", "llamaCpp"]) {
      const v = body[key];
      const list = Array.isArray(v) ? v : Array.isArray(v?.models) ? v.models : null;
      if (list) list.forEach((m) => push(m, key.startsWith("lm") ? "lmstudio" : "llamacpp"));
    }
  }
  return out;
}
