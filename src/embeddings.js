import { json, badRequest, readJson } from "./util.js";
import { pcFetch } from "./pc.js";
import { PROVIDERS } from "./providers.js";
import { sendTrace, normalizeUsage } from "./langfuse.js";

export const NOMIC_MODEL = "text-embedding-nomic-embed-text-v1.5";
export const OPENAI_FALLBACK_MODEL = "text-embedding-3-small";
// OpenAI fallback is shortened to 768 dims so its vectors fit the same Pinecone index as nomic.
export const FALLBACK_DIMENSIONS = 768;

async function viaPc(env, input, model) {
  const r = await pcFetch(env, "/lmstudio/v1/embeddings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: model || env.PC_EMBED_MODEL || NOMIC_MODEL, input }),
  }, 20000);
  if (r.offline) return { ok: false, reason: r.reason };
  if (!r.response.ok) return { ok: false, reason: `bridge returned ${r.response.status}` };
  const body = await r.response.json();
  return { ok: true, body, provider: "local-lmstudio", namespace: "nomic" };
}

async function viaOpenAI(env, input, model, dimensions) {
  if (!env.OPENAI_API_KEY) return { ok: false, reason: "OPENAI_API_KEY not configured" };
  const p = PROVIDERS.openai;
  const payload = { model: model || OPENAI_FALLBACK_MODEL, input };
  if (dimensions !== null) payload.dimensions = dimensions ?? FALLBACK_DIMENSIONS;
  const res = await fetch(`${p.base(env)}/embeddings`, {
    method: "POST",
    headers: { ...p.headers(env), "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) return { ok: false, reason: `openai returned ${res.status}`, status: res.status };
  return { ok: true, body: await res.json(), provider: "openai", namespace: `openai-3-small-${payload.dimensions || "default"}` };
}

// Second fallback when the OpenAI project has no embeddings access: Gemini embeddings at 768 dims.
export const GOOGLE_FALLBACK_MODEL = "gemini-embedding-001";
async function viaGoogle(env, input, dimensions) {
  if (!env.GOOGLE_API_KEY) return { ok: false, reason: "GOOGLE_API_KEY not configured" };
  const p = PROVIDERS.google;
  const res = await fetch(`${p.base(env)}/embeddings`, {
    method: "POST",
    headers: { ...p.headers(env), "content-type": "application/json" },
    body: JSON.stringify({ model: GOOGLE_FALLBACK_MODEL, input, dimensions: dimensions ?? FALLBACK_DIMENSIONS }),
  });
  if (!res.ok) return { ok: false, reason: `google returned ${res.status}` };
  const body = await res.json();
  body.model = body.model || GOOGLE_FALLBACK_MODEL;
  return { ok: true, body, provider: "google", namespace: `gemini-embedding-001-${dimensions ?? FALLBACK_DIMENSIONS}` };
}

/** Embed texts for RAG. Returns { vectors, provider (namespace), source }. */
export async function embed(env, texts) {
  let r = await viaPc(env, texts);
  if (!r.ok) r = await viaOpenAI(env, texts, OPENAI_FALLBACK_MODEL, FALLBACK_DIMENSIONS);
  if (!r.ok) r = await viaGoogle(env, texts, FALLBACK_DIMENSIONS);
  if (!r.ok) throw Object.assign(new Error(`no embedding provider available (${r.reason})`), { status: 503 });
  const vectors = r.body.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
  return { vectors, provider: r.namespace, source: r.provider };
}

export async function handleEmbeddings(request, env, ctx) {
  const started = Date.now();
  const body = await readJson(request);
  if (!body || body.input === undefined) return badRequest("input is required");
  const requested = String(body.model || "");
  let result;
  const wantsOpenAI = /^openai\//.test(requested) || /^text-embedding-3/.test(requested);
  const attempts = [];
  if (!wantsOpenAI) {
    const pcModel = requested.replace(/^(local-lmstudio|lmstudio)\//, "") || undefined;
    result = await viaPc(env, body.input, pcModel && !/nomic/i.test(pcModel) ? pcModel : undefined);
    if (!result.ok) attempts.push({ provider: "local-lmstudio", reason: result.reason });
  }
  if (!result?.ok) {
    const model = wantsOpenAI ? requested.replace(/^openai\//, "") : OPENAI_FALLBACK_MODEL;
    const dims = body.dimensions ?? (wantsOpenAI ? null : FALLBACK_DIMENSIONS);
    result = await viaOpenAI(env, body.input, model, dims);
    if (!result.ok) attempts.push({ provider: "openai", reason: result.reason });
  }
  if (!result.ok && !wantsOpenAI) {
    result = await viaGoogle(env, body.input, body.dimensions ?? FALLBACK_DIMENSIONS);
    if (!result.ok) attempts.push({ provider: "google", reason: result.reason });
  }
  const ended = Date.now();
  const status = result.ok ? 200 : 503;
  const out = result.ok ? result.body : { error: { type: "embeddings_unavailable", message: "no embedding provider available", attempts } };
  ctx.waitUntil(sendTrace(env, {
    name: "embeddings", provider: result.ok ? result.provider : "none", route: "/v1/embeddings", generation: true,
    model: result.ok ? result.body.model : requested, input: { model: requested, items: Array.isArray(body.input) ? body.input.length : 1 },
    output: result.ok ? { vectors: result.body.data?.length, dims: result.body.data?.[0]?.embedding?.length } : out,
    usage: result.ok ? normalizeUsage(result.body.usage) : null, startTime: started, endTime: ended, status,
    metadata: { fallback_attempts: attempts.length ? attempts : undefined },
  }));
  if (result.ok && attempts.length) out.jugginai_fallback = attempts;
  return json(status, out, { "x-jugginai-provider": result.ok ? result.provider : "none" });
}
