export const ACCOUNT_ID = "2cc3a4ec0dbc3969ca8c25a0c20a2465";
export const GATEWAY_BASE = `https://gateway.ai.cloudflare.com/v1/${ACCOUNT_ID}/jugginai`;
export const DEFAULT_PC_BRIDGE_URL = "https://pc.jugginai.net";
export const HF_BILL_TO = "DavesTrapHouse";

// Known models on the Windows PC, used only to show them as offline when the bridge is unreachable.
export const KNOWN_PC_MODELS = [
  { id: "local-lmstudio/nvidia-nemotron-3.5-bolt-e4b", engine: "lmstudio", kind: "chat" },
  { id: "local-lmstudio/text-embedding-nomic-embed-text-v1.5", engine: "lmstudio", kind: "embedding" },
  { id: "local-llamacpp/ornith-1.5-9b-uncensored", engine: "llamacpp", kind: "chat" },
];

function gatewayHeaders(env) {
  return env.CF_AIG_AUTHORIZATION ? { "cf-aig-authorization": `Bearer ${env.CF_AIG_AUTHORIZATION}` } : {};
}

export function pcBridgeUrl(env) {
  return (env.PC_BRIDGE_URL || DEFAULT_PC_BRIDGE_URL).replace(/\/+$/, "");
}

// tag = Langfuse provider tag; key = env secret holding the credential.
export const PROVIDERS = {
  xai: {
    tag: "xai",
    key: "XAI_API_KEY",
    base: () => `${GATEWAY_BASE}/grok/v1`,
    headers: (env) => ({ authorization: `Bearer ${env.XAI_API_KEY}`, ...gatewayHeaders(env) }),
    streamUsage: true,
  },
  openai: {
    tag: "openai",
    key: "OPENAI_API_KEY",
    base: () => `${GATEWAY_BASE}/openai`,
    headers: (env) => ({ authorization: `Bearer ${env.OPENAI_API_KEY}`, ...gatewayHeaders(env) }),
    streamUsage: true,
  },
  openrouter: {
    tag: "openrouter",
    key: "OPENROUTER_API_KEY",
    base: () => "https://openrouter.ai/api/v1",
    headers: (env) => ({
      authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
      "http-referer": "https://ai.jugginai.net",
      "x-title": "JugginAI",
    }),
    streamUsage: true,
  },
  venice: {
    tag: "venice",
    key: "VENICE_API_KEY",
    base: () => "https://api.venice.ai/api/v1",
    headers: (env) => ({ authorization: `Bearer ${env.VENICE_API_KEY}` }),
    streamUsage: true,
  },
  hf: {
    tag: "huggingface",
    key: "HF_TOKEN",
    base: () => "https://router.huggingface.co/v1",
    // Every Hugging Face request is billed to the DavesTrapHouse org.
    headers: (env) => ({ authorization: `Bearer ${env.HF_TOKEN}`, "x-hf-bill-to": HF_BILL_TO }),
    streamUsage: true,
  },
  anthropic: {
    tag: "anthropic",
    key: "ANTHROPIC_API_KEY",
    // Anthropic's OpenAI-compatible endpoint.
    base: () => "https://api.anthropic.com/v1",
    headers: (env) => ({
      authorization: `Bearer ${env.ANTHROPIC_API_KEY}`,
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    }),
    streamUsage: true,
  },
  google: {
    tag: "google",
    key: "GOOGLE_API_KEY",
    base: () => "https://generativelanguage.googleapis.com/v1beta/openai",
    headers: (env) => ({ authorization: `Bearer ${env.GOOGLE_API_KEY}` }),
    streamUsage: true,
  },
  "local-lmstudio": {
    tag: "local-lmstudio",
    key: "PC_BRIDGE_TOKEN",
    local: true,
    base: (env) => `${pcBridgeUrl(env)}/lmstudio/v1`,
    headers: (env) => ({ authorization: `Bearer ${env.PC_BRIDGE_TOKEN}` }),
    streamUsage: false,
  },
  "local-llamacpp": {
    tag: "local-llamacpp",
    key: "PC_BRIDGE_TOKEN",
    local: true,
    base: (env) => `${pcBridgeUrl(env)}/llamacpp/v1`,
    headers: (env) => ({ authorization: `Bearer ${env.PC_BRIDGE_TOKEN}` }),
    streamUsage: false,
  },
};

const ALIASES = {
  grok: "xai",
  "x-ai": "xai",
  huggingface: "hf",
  gemini: "google",
  claude: "anthropic",
  lmstudio: "local-lmstudio",
  llamacpp: "local-llamacpp",
  "llama.cpp": "local-llamacpp",
};

// Venice retired qwen-2.5-vl; map the old name and a generic alias to its current vision model.
export const VENICE_VISION_MODEL = "qwen3-vl-235b-a22b";
const VENICE_MODEL_ALIASES = { "qwen-2.5-vl": VENICE_VISION_MODEL, "qwen-2.5-vl-72b": VENICE_VISION_MODEL, vision: VENICE_VISION_MODEL };

export function hasImageContent(messages) {
  return Array.isArray(messages) && messages.some((m) => Array.isArray(m?.content) && m.content.some((p) => p?.type === "image_url"));
}

/** Resolve "provider/model" into { providerId, provider, model }. */
export function resolveModel(rawModel, messages) {
  const model = String(rawModel || "").trim();
  if (!model) return { error: "model is required, e.g. xai/grok-4 or venice/qwen-2.5-vl" };
  const slash = model.indexOf("/");
  let providerId = null;
  let upstreamModel = model;
  if (slash > 0) {
    const prefix = model.slice(0, slash).toLowerCase();
    const id = ALIASES[prefix] || prefix;
    if (PROVIDERS[id]) {
      providerId = id;
      upstreamModel = model.slice(slash + 1);
    }
  }
  if (!providerId) {
    if (/^grok/i.test(model)) providerId = "xai";
    else if (/^(gpt-|o\d|chatgpt|text-embedding|dall-e|gpt)/i.test(model)) providerId = "openai";
    else if (/^claude/i.test(model)) providerId = "anthropic";
    else if (/^gemini/i.test(model)) providerId = "google";
    else if (VENICE_MODEL_ALIASES[model]) providerId = "venice";
    else return { error: `unknown provider for model "${model}"; prefix it with one of: ${Object.keys(PROVIDERS).join(", ")}` };
  }
  if (providerId === "venice") {
    if (VENICE_MODEL_ALIASES[upstreamModel]) upstreamModel = VENICE_MODEL_ALIASES[upstreamModel];
  }
  return { providerId, provider: PROVIDERS[providerId], model: upstreamModel };
}

export function providerStatus(env) {
  const out = {};
  for (const [id, p] of Object.entries(PROVIDERS)) out[id] = { configured: Boolean(env[p.key]), key: p.key, tag: p.tag };
  return out;
}
