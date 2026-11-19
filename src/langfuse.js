// Langfuse US cloud tracing over OpenTelemetry. Only LANGFUSE_BASE_URL is honored; LANGFUSE_HOST is ignored on purpose.
export const SERVICE = "jugginai-ai-proxy";
const DEFAULT_BASE = "https://us.cloud.langfuse.com";
const MAX_FIELD = 8000;

function b64(s) {
  return btoa(unescape(encodeURIComponent(s)));
}

// Drop inline image bytes and cap size so traces stay small and never carry large payloads.
export function sanitize(value) {
  try {
    const text = JSON.stringify(value, (k, v) => {
      if (typeof v === "string" && v.startsWith("data:") && v.length > 200) return `${v.slice(0, 40)}…[${v.length} bytes omitted]`;
      if (typeof v === "string" && v.length > 4000) return `${v.slice(0, 4000)}…[truncated]`;
      return v;
    });
    if (text === undefined) return null;
    if (text.length > MAX_FIELD) return { truncated: true, preview: text.slice(0, MAX_FIELD) };
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function langfuseConfigured(env) {
  return Boolean(env.LANGFUSE_PUBLIC_KEY && env.LANGFUSE_SECRET_KEY);
}

function hex(bytes) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function attr(key, value) {
  if (value === undefined || value === null) return null;
  if (Array.isArray(value)) return { key, value: { arrayValue: { values: value.map((v) => ({ stringValue: String(v) })) } } };
  if (typeof value === "boolean") return { key, value: { boolValue: value } };
  if (typeof value === "number" && Number.isInteger(value)) return { key, value: { intValue: String(value) } };
  if (typeof value === "number") return { key, value: { doubleValue: value } };
  if (typeof value === "object") return { key, value: { stringValue: JSON.stringify(value) } };
  return { key, value: { stringValue: String(value) } };
}

const nanos = (ms) => `${BigInt(Math.round(ms)) * 1000000n}`;

/**
 * Record one trace via Langfuse OpenTelemetry ingestion (POST /api/public/otel/v1/traces, OTLP/HTTP JSON).
 * The legacy /api/public/ingestion trace events were retired by Langfuse Cloud on 2026-11-16.
 * opts: { name, provider, route, model, input, output, startTime, endTime, completionStartTime,
 *         usage: {input, output, total}, status, toolCalls, spans: [{name,input,output,startTime,endTime,metadata,error}], metadata, generation: bool }
 */
export async function sendTrace(env, opts) {
  if (!langfuseConfigured(env)) return { skipped: true };
  const base = (env.LANGFUSE_BASE_URL || DEFAULT_BASE).replace(/\/+$/, "");
  const traceId = hex(16);
  const rootId = hex(8);
  const now = Date.now();
  const startMs = opts.startTime || now;
  const endMs = opts.endTime || now;
  const provider = opts.provider || "none";
  const status = opts.status || 200;
  const isError = status >= 400;
  const tags = [`service:${SERVICE}`, `provider:${provider}`, SERVICE, provider];
  const meta = {
    service: SERVICE,
    provider,
    route: opts.route,
    status,
    latency_ms: endMs - startMs,
    ...(opts.metadata || {}),
  };
  if (opts.toolCalls && opts.toolCalls.length) meta.tool_calls = sanitize(opts.toolCalls);
  // Trace-level attributes are propagated to every span, as Langfuse requires.
  const traceAttrs = [
    attr("langfuse.trace.name", opts.name),
    attr("langfuse.trace.tags", tags),
    attr("langfuse.trace.metadata.service", SERVICE),
    attr("langfuse.trace.metadata.provider", provider),
    attr("langfuse.trace.metadata.route", opts.route),
    attr("langfuse.environment", "production"),
  ];
  const obsMeta = Object.entries(meta)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => attr(`langfuse.observation.metadata.${k}`, typeof v === "object" ? JSON.stringify(v) : String(v)));
  const rootAttrs = [
    ...traceAttrs,
    ...obsMeta,
    attr("langfuse.observation.type", opts.generation ? "generation" : "span"),
    attr("langfuse.observation.input", sanitize(opts.input)),
    attr("langfuse.observation.output", sanitize(opts.output)),
    attr("langfuse.observation.level", isError ? "ERROR" : "DEFAULT"),
    isError ? attr("langfuse.observation.status_message", `HTTP ${status}`) : null,
  ];
  if (opts.generation) {
    const u = opts.usage || {};
    const usage = {};
    if (Number.isFinite(u.input)) usage.input = u.input;
    if (Number.isFinite(u.output)) usage.output = u.output;
    if (Number.isFinite(u.total)) usage.total = u.total;
    rootAttrs.push(
      attr("langfuse.observation.model.name", opts.model),
      attr("gen_ai.request.model", opts.model),
      attr("gen_ai.system", provider),
      Object.keys(usage).length ? attr("langfuse.observation.usage_details", usage) : null,
      opts.completionStartTime ? attr("langfuse.observation.completion_start_time", new Date(opts.completionStartTime).toISOString()) : null,
    );
  }
  const spans = [
    {
      traceId,
      spanId: rootId,
      name: opts.name,
      kind: 2,
      startTimeUnixNano: nanos(startMs),
      endTimeUnixNano: nanos(endMs),
      attributes: rootAttrs.filter(Boolean),
      status: { code: isError ? 2 : 1, message: isError ? `HTTP ${status}` : "" },
    },
  ];
  const children = [...(opts.spans || [])];
  for (const tc of opts.toolCalls || []) {
    if (tc?.function?.name) children.push({ name: `tool_call:${tc.function.name}`, type: "tool", input: tc.function.arguments, metadata: { tool_call_id: tc.id } });
  }
  for (const span of children) {
    spans.push({
      traceId,
      spanId: hex(8),
      parentSpanId: rootId,
      name: span.name,
      kind: 1,
      startTimeUnixNano: nanos(span.startTime || startMs),
      endTimeUnixNano: nanos(span.endTime || endMs),
      attributes: [
        ...traceAttrs,
        attr("langfuse.observation.type", span.type || "tool"),
        attr("langfuse.observation.input", sanitize(span.input)),
        attr("langfuse.observation.output", sanitize(span.output)),
        attr("langfuse.observation.level", span.error ? "ERROR" : "DEFAULT"),
        ...Object.entries({ service: SERVICE, provider, ...(span.metadata || {}) })
          .filter(([, v]) => v !== undefined && v !== null)
          .map(([k, v]) => attr(`langfuse.observation.metadata.${k}`, String(v))),
      ].filter(Boolean),
      status: { code: span.error ? 2 : 1 },
    });
  }
  const payload = {
    resourceSpans: [{
      resource: { attributes: [attr("service.name", SERVICE), attr("deployment.environment", "production")] },
      scopeSpans: [{ scope: { name: SERVICE, version: "2.0.0" }, spans }],
    }],
  };
  try {
    const res = await fetch(`${base}/api/public/otel/v1/traces`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-langfuse-ingestion-version": "4",
        authorization: `Basic ${b64(`${env.LANGFUSE_PUBLIC_KEY}:${env.LANGFUSE_SECRET_KEY}`)}`,
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) console.error("langfuse otel status", res.status);
    return { traceId, status: res.status };
  } catch {
    console.error("langfuse otel export failed");
    return { traceId, error: true };
  }
}

// Parse an OpenAI-style SSE stream copy to recover output text, tool calls, and usage.
export async function collectSse(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let text = "";
  let usage = null;
  let firstTokenAt = null;
  let model = null;
  const tools = new Map();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      let chunk;
      try { chunk = JSON.parse(data); } catch { continue; }
      if (chunk.model) model = chunk.model;
      if (chunk.usage) usage = chunk.usage;
      for (const choice of chunk.choices || []) {
        const d = choice.delta || {};
        if (d.content) {
          if (!firstTokenAt) firstTokenAt = Date.now();
          text += d.content;
        }
        for (const tc of d.tool_calls || []) {
          const key = tc.index ?? tc.id ?? tools.size;
          const cur = tools.get(key) || { id: tc.id, type: "function", function: { name: "", arguments: "" } };
          if (tc.id) cur.id = tc.id;
          if (tc.function?.name) cur.function.name += tc.function.name;
          if (tc.function?.arguments) cur.function.arguments += tc.function.arguments;
          tools.set(key, cur);
        }
      }
    }
  }
  return { text, usage, firstTokenAt, model, toolCalls: [...tools.values()] };
}

export function normalizeUsage(u) {
  if (!u) return null;
  const input = u.prompt_tokens ?? u.input_tokens;
  const output = u.completion_tokens ?? u.output_tokens;
  const total = u.total_tokens ?? (Number.isFinite(input) && Number.isFinite(output) ? input + output : undefined);
  return { input, output, total };
}
