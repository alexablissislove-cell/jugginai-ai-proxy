import { json, authorized, readJson, badRequest, notConfigured, copyResponseHeaders, fetchWithHeaderTimeout, HOP_BY_HOP } from "./util.js";
import { PROVIDERS, GATEWAY_BASE, KNOWN_PC_MODELS, resolveModel, hasImageContent, providerStatus, VENICE_VISION_MODEL } from "./providers.js";
import { sendTrace, collectSse, normalizeUsage, langfuseConfigured } from "./langfuse.js";
import { pcFetch, pcOffline, handlePcPassthrough, normalizeInstalled } from "./pc.js";
import { handleEmbeddings } from "./embeddings.js";
import { handleTools } from "./tools.js";

// ---------- Legacy passthrough: /openai/* and /grok/* via the jugginai AI Gateway ----------
function legacyRoute(urlPath) {
  if (urlPath === "/openai" || urlPath.startsWith("/openai/")) {
    return { provider: "openai", rest: urlPath.slice("/openai".length) || "/", keyName: "OPENAI_API_KEY", tag: "openai" };
  }
  if (urlPath === "/grok" || urlPath.startsWith("/grok/")) {
    return { provider: "grok", rest: urlPath.slice("/grok".length) || "/", keyName: "XAI_API_KEY", tag: "xai" };
  }
  return null;
}

async function handleLegacy(request, env, ctx, url, matched) {
  const providerKey = env[matched.keyName] || "";
  if (!providerKey) return json(500, { error: `missing provider credentials for ${matched.provider}` });
  const cfToken = env.CF_AIG_AUTHORIZATION || "";
  if (!cfToken) return json(500, { error: "missing gateway credentials" });
  const started = Date.now();
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
  const upstream = await fetch(target, { method, headers, body: hasBody ? request.body : undefined });
  ctx.waitUntil(sendTrace(env, {
    name: `legacy ${method} /${matched.provider}${matched.rest}`, provider: matched.tag, route: `/${matched.provider}/*`,
    startTime: started, endTime: Date.now(), status: upstream.status,
  }));
  return new Response(upstream.body, { status: upstream.status, headers: copyResponseHeaders(upstream) });
}

// ---------- /v1/models ----------
async function listProviderModels(env, id, p) {
  if (!env[p.key]) return { id, status: "not_configured", models: [] };
  try {
    const res = await fetchWithHeaderTimeout(`${p.base(env)}/models`, { headers: p.headers(env) }, 8000);
    if (!res.ok) return { id, status: `error_${res.status}`, models: [] };
    const body = await res.json();
    const list = Array.isArray(body) ? body : body.data || body.models || [];
    const models = list.map((m) => {
      const mid = String(m.id || m.name || "").replace(/^models\//, "");
      return { id: `${id}/${mid}`, object: "model", owned_by: m.owned_by || id, provider: p.tag, status: "online", created: m.created };
    }).filter((m) => !m.id.endsWith("/"));
    return { id, status: "online", models };
  } catch {
    return { id, status: "unreachable", models: [] };
  }
}

async function pcModels(env) {
  const [healthR, installedR] = await Promise.all([
    pcFetch(env, "/health", {}, 6000),
    pcFetch(env, "/models/installed", {}, 8000),
  ]);
  let health = null;
  if (!healthR.offline && healthR.response.ok) health = await healthR.response.json().catch(() => null);
  if (installedR.offline || !installedR.response.ok) {
    const reason = installedR.reason || `bridge returned ${installedR.response?.status}`;
    return {
      status: "offline", reason, health,
      models: KNOWN_PC_MODELS.map((m) => ({ id: m.id, object: "model", owned_by: "pc", provider: `local-${m.engine}`, kind: m.kind, status: "offline", source: "known" })),
    };
  }
  const installed = normalizeInstalled(await installedR.response.json().catch(() => null));
  const engineUp = (engine) => {
    if (!health) return null;
    const h = health.engines?.[engine] ?? health[engine] ?? health[engine === "lmstudio" ? "lmStudio" : "llamaCpp"];
    if (h === undefined) return null;
    return typeof h === "object" ? Boolean(h.online ?? h.ok ?? h.up) : Boolean(h);
  };
  return {
    status: "online", health,
    models: installed.map((m) => {
      const up = engineUp(m.engine);
      return {
        id: `local-${m.engine}/${m.id}`, object: "model", owned_by: "pc", provider: `local-${m.engine}`, kind: m.kind,
        loaded: m.loaded, status: m.loaded && up !== false ? "online" : "standby",
      };
    }),
  };
}

async function handleModels(env) {
  const cloud = Object.entries(PROVIDERS).filter(([, p]) => !p.local);
  const [cloudResults, pc] = await Promise.all([
    Promise.all(cloud.map(([id, p]) => listProviderModels(env, id, p))),
    pcModels(env),
  ]);
  const data = [...pc.models];
  const providers = {};
  for (const r of cloudResults) {
    providers[r.id] = { status: r.status, count: r.models.length };
    data.push(...r.models);
  }
  providers.pc = { status: pc.status, count: pc.models.length, reason: pc.reason };
  return json(200, { object: "list", data, providers });
}

// ---------- /v1/chat/completions ----------
async function handleChat(request, env, ctx) {
  const started = Date.now();
  const body = await readJson(request);
  if (!body) return badRequest("JSON body required");
  const images = hasImageContent(body.messages);
  let rawModel = body.model;
  if (!rawModel && images) rawModel = `venice/${VENICE_VISION_MODEL}`;
  const r = resolveModel(rawModel, body.messages);
  if (r.error) return badRequest(r.error);
  const { providerId, provider, model } = r;
  if (!env[provider.key]) {
    if (provider.local) return pcOffline("PC_BRIDGE_TOKEN not configured");
    return notConfigured(providerId, provider.key);
  }
  const payload = { ...body, model };
  const stream = Boolean(body.stream);
  if (stream && provider.streamUsage) payload.stream_options = { include_usage: true, ...(body.stream_options || {}) };

  let upstream;
  try {
    upstream = await fetchWithHeaderTimeout(`${provider.base(env)}/chat/completions`, {
      method: "POST",
      headers: { ...provider.headers(env), "content-type": "application/json", accept: stream ? "text/event-stream" : "application/json" },
      body: JSON.stringify(payload),
    }, provider.local ? 60000 : 120000);
  } catch (err) {
    ctx.waitUntil(sendTrace(env, { name: "chat.completions", provider: provider.tag, route: "/v1/chat/completions", generation: true, model, input: body.messages, startTime: started, endTime: Date.now(), status: provider.local ? 503 : 504 }));
    return provider.local ? pcOffline("network error") : json(504, { error: { type: "upstream_timeout", message: `${providerId} did not respond` } });
  }
  if (provider.local && [502, 503, 504, 521, 522, 523, 524, 530].includes(upstream.status) && (upstream.headers.get("content-type") || "").includes("text/html")) {
    return pcOffline(`bridge returned ${upstream.status}`);
  }
  const extra = { "x-jugginai-provider": provider.tag, "x-jugginai-model": model };
  const traceBase = {
    name: "chat.completions", provider: provider.tag, route: "/v1/chat/completions", generation: true, model,
    input: body.messages, startTime: started, status: upstream.status,
    metadata: { stream, multimodal: images || undefined, requested_model: body.model, tools_offered: Array.isArray(body.tools) ? body.tools.map((t) => t.function?.name || t.type) : undefined },
  };

  const isSse = (upstream.headers.get("content-type") || "").includes("text/event-stream");
  if (stream && upstream.ok && isSse && upstream.body) {
    const [toClient, toTrace] = upstream.body.tee();
    ctx.waitUntil((async () => {
      const c = await collectSse(toTrace);
      await sendTrace(env, {
        ...traceBase, model: c.model || model, output: { role: "assistant", content: c.text, tool_calls: c.toolCalls.length ? c.toolCalls : undefined },
        usage: normalizeUsage(c.usage), toolCalls: c.toolCalls, completionStartTime: c.firstTokenAt, endTime: Date.now(),
      });
    })().catch(() => {}));
    const headers = copyResponseHeaders(upstream, extra);
    headers.set("cache-control", "no-cache");
    return new Response(toClient, { status: upstream.status, headers });
  }

  const text = await upstream.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch {}
  const msg = parsed?.choices?.[0]?.message;
  ctx.waitUntil(sendTrace(env, {
    ...traceBase, model: parsed?.model || model, output: msg || parsed?.error || text.slice(0, 500),
    usage: normalizeUsage(parsed?.usage), toolCalls: msg?.tool_calls || [], endTime: Date.now(),
  }));
  return new Response(text, { status: upstream.status, headers: copyResponseHeaders(upstream, extra) });
}

// ---------- /v1/images/generations (Venice) ----------
const VENICE_IMAGE_FIELDS = ["negative_prompt", "style_preset", "steps", "cfg_scale", "seed", "width", "height", "safe_mode", "format", "hide_watermark", "lora_strength", "aspect_ratio", "resolution", "embed_exif_metadata"];

async function handleImages(request, env, ctx) {
  const started = Date.now();
  if (!env.VENICE_API_KEY) return notConfigured("venice", "VENICE_API_KEY");
  const body = await readJson(request);
  if (!body?.prompt) return badRequest("prompt is required");
  const model = String(body.model || "venice-sd35").replace(/^venice\//, "");
  const payload = { model, prompt: body.prompt, return_binary: false };
  for (const k of VENICE_IMAGE_FIELDS) if (body[k] !== undefined) payload[k] = body[k];
  if (body.size && !payload.width && /^\d+x\d+$/.test(body.size)) {
    const [w, h] = body.size.split("x").map(Number);
    payload.width = w;
    payload.height = h;
  }
  if (body.n && body.n > 1) payload.variants = Math.min(4, body.n);
  const upstream = await fetchWithHeaderTimeout("https://api.venice.ai/api/v1/image/generate", {
    method: "POST",
    headers: { ...PROVIDERS.venice.headers(env), "content-type": "application/json" },
    body: JSON.stringify(payload),
  }, 180000);
  const text = await upstream.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch {}
  const ended = Date.now();
  ctx.waitUntil(sendTrace(env, {
    name: "images.generations", provider: "venice", route: "/v1/images/generations", generation: true, model,
    input: { ...payload, prompt: body.prompt }, output: upstream.ok ? { images: parsed?.images?.length || 0, timing: parsed?.timing } : (parsed || text.slice(0, 500)),
    startTime: started, endTime: ended, status: upstream.status,
  }));
  if (!upstream.ok || !parsed?.images) {
    return new Response(text, { status: upstream.ok ? 502 : upstream.status, headers: { "content-type": upstream.headers.get("content-type") || "application/json" } });
  }
  return json(200, {
    created: Math.floor(started / 1000),
    model,
    data: parsed.images.map((b64) => ({ b64_json: b64, revised_prompt: body.prompt })),
    venice: { id: parsed.id, timing: parsed.timing },
  }, { "x-jugginai-provider": "venice" });
}

// ---------- /v1/audio/speech (Venice Kokoro) ----------
async function handleSpeech(request, env, ctx) {
  const started = Date.now();
  if (!env.VENICE_API_KEY) return notConfigured("venice", "VENICE_API_KEY");
  const body = await readJson(request);
  if (!body?.input) return badRequest("input is required");
  const model = String(body.model || "tts-kokoro").replace(/^venice\//, "");
  const payload = {
    model: model === "tts-1" || model === "tts-1-hd" ? "tts-kokoro" : model,
    input: body.input,
    voice: body.voice || "af_sky",
    response_format: "mp3",
  };
  if (body.speed !== undefined) payload.speed = body.speed;
  const upstream = await fetchWithHeaderTimeout("https://api.venice.ai/api/v1/audio/speech", {
    method: "POST",
    headers: { ...PROVIDERS.venice.headers(env), "content-type": "application/json" },
    body: JSON.stringify(payload),
  }, 120000);
  ctx.waitUntil(sendTrace(env, {
    name: "audio.speech", provider: "venice", route: "/v1/audio/speech", generation: true, model: payload.model,
    input: payload, output: { status: upstream.status, bytes: Number(upstream.headers.get("content-length")) || undefined },
    usage: { input: String(body.input).length }, startTime: started, endTime: Date.now(), status: upstream.status,
    metadata: { usage_unit: "characters" },
  }));
  if (!upstream.ok) return new Response(upstream.body, { status: upstream.status, headers: copyResponseHeaders(upstream) });
  return new Response(upstream.body, { status: 200, headers: { "content-type": "audio/mpeg", "x-jugginai-provider": "venice" } });
}

// ---------- router ----------
export default {
  async fetch(request, env, ctx) {
    try {
      const token = env.AI_PROXY_TOKEN || "";
      if (!token || !authorized(request.headers.get("authorization"), token)) {
        return json(401, { error: "unauthorized" });
      }
      const url = new URL(request.url);
      const path = url.pathname.replace(/\/+$/, "") || "/";
      const method = request.method;

      const legacy = legacyRoute(url.pathname);
      if (legacy) return await handleLegacy(request, env, ctx, url, legacy);

      if (path === "/v1/models" && method === "GET") return await handleModels(env);
      if (path === "/v1/chat/completions" && method === "POST") return await handleChat(request, env, ctx);
      if (path === "/v1/embeddings" && method === "POST") return await handleEmbeddings(request, env, ctx);
      if (path === "/v1/images/generations" && method === "POST") return await handleImages(request, env, ctx);
      if (path === "/v1/audio/speech" && method === "POST") return await handleSpeech(request, env, ctx);
      if (path === "/v1/pc" || path.startsWith("/v1/pc/")) return await handlePcPassthrough(request, env, url.pathname.slice("/v1/pc".length) || "/", url.search);
      if (path === "/v1/tools" || path.startsWith("/v1/tools/")) return await handleTools(request, env, ctx, url);
      if (path === "/v1/providers" && method === "GET") {
        return json(200, {
          providers: providerStatus(env),
          tools: {
            brave: Boolean(env.BRAVE_API_KEY), context7: Boolean(env.CONTEXT7_API_KEY), pinecone: Boolean(env.PINECONE_API_KEY),
            composio: Boolean(env.COMPOSIO_API_KEY), linear: Boolean(env.LINEAR_API_KEY), r2: Boolean(env.RAG_BUCKET),
          },
          langfuse: { configured: langfuseConfigured(env), base_url: env.LANGFUSE_BASE_URL },
          pc_bridge: { url: env.PC_BRIDGE_URL, token_configured: Boolean(env.PC_BRIDGE_TOKEN) },
        });
      }
      return json(404, { error: "not found" });
    } catch (err) {
      console.error("ai-proxy error:", err instanceof Error ? err.message : "request failed");
      return json(502, { error: "upstream error" });
    }
  },
};
