import { json, notConfigured, badRequest, readJson, fetchWithHeaderTimeout, copyResponseHeaders } from "./util.js";
import { sendTrace } from "./langfuse.js";
import { embed } from "./embeddings.js";

const DEFAULT_INDEX = "jugginai-rag";
const indexHosts = new Map();

async function traced(ctx, env, name, provider, input, fn) {
  const started = Date.now();
  let status = 500;
  let output = null;
  try {
    const res = await fn();
    status = res.status;
    if ((res.headers.get("content-type") || "").includes("json")) {
      output = await res.clone().json().catch(() => null);
    }
    return res;
  } finally {
    const ended = Date.now();
    ctx.waitUntil(sendTrace(env, {
      name: `tool.${name}`, provider, route: `/v1/tools/${name}`, input, output, startTime: started, endTime: ended, status,
      toolCalls: [{ tool: name, status }],
      spans: [{ name: `tool:${name}`, input, output, startTime: started, endTime: ended, error: status >= 400, metadata: { tool: name, status } }],
    }));
  }
}

async function params(request, url) {
  const q = Object.fromEntries(url.searchParams.entries());
  if (request.method === "GET") return q;
  const body = (await readJson(request)) || {};
  return { ...q, ...body };
}

// ---------- Brave Search ----------
async function braveSearch(request, env, url) {
  if (!env.BRAVE_API_KEY) return notConfigured("Brave Search", "BRAVE_API_KEY");
  const p = await params(request, url);
  const q = p.q || p.query;
  if (!q) return badRequest("q is required");
  const type = p.type === "news" ? "news" : p.type === "images" ? "images" : "web";
  const qs = new URLSearchParams({ q, count: String(p.count || 10) });
  for (const k of ["offset", "country", "search_lang", "freshness", "safesearch"]) if (p[k]) qs.set(k, String(p[k]));
  const res = await fetchWithHeaderTimeout(`https://api.search.brave.com/res/v1/${type}/search?${qs}`, {
    headers: { accept: "application/json", "x-subscription-token": env.BRAVE_API_KEY },
  });
  return new Response(res.body, { status: res.status, headers: copyResponseHeaders(res) });
}

// ---------- Context7 docs ----------
async function context7(request, env, url, sub) {
  if (!env.CONTEXT7_API_KEY) return notConfigured("Context7", "CONTEXT7_API_KEY");
  const p = await params(request, url);
  const headers = { authorization: `Bearer ${env.CONTEXT7_API_KEY}` };
  let target;
  if (sub === "search") {
    if (!p.libraryName && !p.q) return badRequest("libraryName is required");
    target = `https://context7.com/api/v2/libs/search?${new URLSearchParams({ libraryName: p.libraryName || p.q, query: p.query || p.libraryName || p.q })}`;
  } else if (sub === "docs") {
    if (!p.libraryId) return badRequest("libraryId is required, e.g. /vercel/next.js");
    const qs = new URLSearchParams({ libraryId: p.libraryId, query: p.query || p.topic || "" });
    if (p.tokens) qs.set("tokens", String(p.tokens));
    target = `https://context7.com/api/v2/context?${qs}`;
  } else return json(404, { error: "use /v1/tools/context7/search or /v1/tools/context7/docs" });
  const res = await fetchWithHeaderTimeout(target, { headers });
  return new Response(res.body, { status: res.status, headers: copyResponseHeaders(res) });
}

// ---------- Pinecone ----------
async function indexHost(env, name) {
  if (indexHosts.has(name)) return indexHosts.get(name);
  const res = await fetch(`https://api.pinecone.io/indexes/${encodeURIComponent(name)}`, {
    headers: { "api-key": env.PINECONE_API_KEY, "x-pinecone-api-version": "2025-04" },
  });
  if (!res.ok) throw Object.assign(new Error("index lookup failed"), { status: res.status });
  const info = await res.json();
  indexHosts.set(name, info.host);
  return info.host;
}

async function pineconeCall(env, index, path, body) {
  const host = await indexHost(env, index);
  return fetch(`https://${host}${path}`, {
    method: "POST",
    headers: { "api-key": env.PINECONE_API_KEY, "content-type": "application/json", "x-pinecone-api-version": "2025-04" },
    body: JSON.stringify(body),
  });
}

async function pinecone(request, env, url, sub, ctx) {
  if (!env.PINECONE_API_KEY) return notConfigured("Pinecone", "PINECONE_API_KEY");
  const p = await params(request, url);
  const index = p.index || env.PINECONE_INDEX || DEFAULT_INDEX;
  try {
    if (sub === "query") {
      let vector = p.vector;
      let embeddedWith = null;
      if (!vector && (p.text || p.query)) {
        const e = await embed(env, [p.text || p.query]);
        vector = e.vectors[0];
        embeddedWith = e.provider;
      }
      if (!Array.isArray(vector)) return badRequest("vector or text is required");
      const res = await pineconeCall(env, index, "/query", {
        vector, topK: Number(p.topK || 5), namespace: p.namespace || (embeddedWith ? embeddedWith : ""),
        filter: p.filter, includeMetadata: p.includeMetadata ?? true, includeValues: p.includeValues ?? false,
      });
      const body = await res.json().catch(() => ({}));
      return json(res.status, { index, embedded_with: embeddedWith, ...body });
    }
    if (sub === "upsert") {
      let vectors = p.vectors;
      const namespace = p.namespace;
      if (!vectors && Array.isArray(p.records)) {
        const e = await embed(env, p.records.map((r) => r.text));
        vectors = p.records.map((r, i) => ({ id: r.id || crypto.randomUUID(), values: e.vectors[i], metadata: { ...(r.metadata || {}), text: r.text } }));
        const res = await pineconeCall(env, index, "/vectors/upsert", { vectors, namespace: namespace || e.provider });
        const body = await res.json().catch(() => ({}));
        return json(res.status, { index, namespace: namespace || e.provider, embedded_with: e.provider, ...body });
      }
      if (!Array.isArray(vectors)) return badRequest("vectors or records is required");
      const res = await pineconeCall(env, index, "/vectors/upsert", { vectors, namespace: namespace || "" });
      const body = await res.json().catch(() => ({}));
      return json(res.status, { index, ...body });
    }
    return json(404, { error: "use /v1/tools/pinecone/query or /v1/tools/pinecone/upsert" });
  } catch (err) {
    return json(err.status || 502, { error: { type: "pinecone_error", message: err.message } });
  }
}

// ---------- R2 document RAG ----------
function chunkText(text, size = 1200, overlap = 150) {
  const chunks = [];
  const clean = String(text).replace(/\r/g, "");
  for (let i = 0; i < clean.length; i += size - overlap) {
    const c = clean.slice(i, i + size).trim();
    if (c) chunks.push(c);
    if (i + size >= clean.length) break;
  }
  return chunks;
}

async function rag(request, env, url, sub) {
  if (!env.PINECONE_API_KEY) return notConfigured("Pinecone", "PINECONE_API_KEY");
  if (!env.RAG_BUCKET) return notConfigured("R2 bucket", "RAG_BUCKET");
  const p = await params(request, url);
  const index = p.index || env.PINECONE_INDEX || DEFAULT_INDEX;
  try {
    if (sub === "ingest") {
      let text = p.text;
      let key = p.key;
      if (!text && key) {
        const obj = await env.RAG_BUCKET.get(key);
        if (!obj) return json(404, { error: `R2 object ${key} not found` });
        text = await obj.text();
      }
      if (!text) return badRequest("text or key is required");
      if (!key) {
        const name = String(p.filename || "document.txt").replace(/[^\w.\-]+/g, "_");
        key = `rag/${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}-${name}`;
        await env.RAG_BUCKET.put(key, text, { httpMetadata: { contentType: "text/plain; charset=utf-8" } });
      }
      const chunks = chunkText(text);
      const e = await embed(env, chunks);
      const vectors = chunks.map((c, i) => ({ id: `${key}#${i}`, values: e.vectors[i], metadata: { source: key, chunk: i, text: c } }));
      let upserted = 0;
      for (let i = 0; i < vectors.length; i += 100) {
        const res = await pineconeCall(env, index, "/vectors/upsert", { vectors: vectors.slice(i, i + 100), namespace: e.provider });
        if (!res.ok) return json(res.status, { error: "pinecone upsert failed", status: res.status });
        upserted += (await res.json()).upsertedCount || 0;
      }
      return json(200, { key, bucket: "jugginai", index, namespace: e.provider, embedded_with: e.provider, chunks: chunks.length, upserted });
    }
    if (sub === "query") {
      const q = p.query || p.q;
      if (!q) return badRequest("query is required");
      const e = await embed(env, [q]);
      const res = await pineconeCall(env, index, "/query", { vector: e.vectors[0], topK: Number(p.topK || 5), namespace: e.provider, includeMetadata: true });
      const body = await res.json().catch(() => ({}));
      const matches = (body.matches || []).map((m) => ({ id: m.id, score: m.score, source: m.metadata?.source, chunk: m.metadata?.chunk, text: m.metadata?.text }));
      return json(res.status, { index, namespace: e.provider, embedded_with: e.provider, matches });
    }
    return json(404, { error: "use /v1/tools/rag/ingest or /v1/tools/rag/query" });
  } catch (err) {
    return json(err.status || 502, { error: { type: "rag_error", message: err.message } });
  }
}

// ---------- Composio (thin passthrough to the v3 API) ----------
async function composio(request, env, rest, search) {
  if (!env.COMPOSIO_API_KEY) return notConfigured("Composio", "COMPOSIO_API_KEY");
  const path = rest && rest !== "/" ? rest : "/toolkits";
  const hasBody = !["GET", "HEAD"].includes(request.method);
  const res = await fetchWithHeaderTimeout(`https://backend.composio.dev/api/v3${path}${search}`, {
    method: request.method,
    headers: { "x-api-key": env.COMPOSIO_API_KEY, "content-type": request.headers.get("content-type") || "application/json", accept: "application/json" },
    body: hasBody ? request.body : undefined,
  }, 30000);
  return new Response(res.body, { status: res.status, headers: copyResponseHeaders(res) });
}

// ---------- Linear (GraphQL) ----------
async function linear(request, env) {
  if (!env.LINEAR_API_KEY) return notConfigured("Linear", "LINEAR_API_KEY");
  if (request.method !== "POST") return json(405, { error: "POST a GraphQL body: { query, variables }" });
  const body = await readJson(request);
  if (!body?.query) return badRequest("query is required");
  const res = await fetchWithHeaderTimeout("https://api.linear.app/graphql", {
    method: "POST",
    headers: { authorization: env.LINEAR_API_KEY, "content-type": "application/json" },
    body: JSON.stringify({ query: body.query, variables: body.variables || {} }),
  });
  return new Response(res.body, { status: res.status, headers: copyResponseHeaders(res) });
}

export async function handleTools(request, env, ctx, url) {
  const parts = url.pathname.replace(/^\/v1\/tools\/?/, "").split("/");
  const tool = parts[0];
  const sub = parts[1];
  const rest = "/" + parts.slice(1).join("/");
  const input = { method: request.method, path: url.pathname, query: Object.fromEntries(url.searchParams) };
  switch (tool) {
    case "":
      return json(200, {
        tools: ["brave-search", "context7/search", "context7/docs", "pinecone/query", "pinecone/upsert", "rag/ingest", "rag/query", "composio/*", "linear"],
      });
    case "brave-search":
      return traced(ctx, env, "brave-search", "brave", input, () => braveSearch(request, env, url));
    case "context7":
      return traced(ctx, env, `context7.${sub}`, "context7", input, () => context7(request, env, url, sub));
    case "pinecone":
      return traced(ctx, env, `pinecone.${sub}`, "pinecone", input, () => pinecone(request, env, url, sub, ctx));
    case "rag":
      return traced(ctx, env, `rag.${sub}`, "pinecone", input, () => rag(request, env, url, sub));
    case "composio":
      return traced(ctx, env, "composio", "composio", input, () => composio(request, env, rest, url.search));
    case "linear":
      return traced(ctx, env, "linear", "linear", input, () => linear(request, env));
    default:
      return json(404, { error: `unknown tool ${tool}` });
  }
}
