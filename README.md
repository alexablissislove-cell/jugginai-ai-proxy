# jugginai-ai-proxy

Private, unified OpenAI-compatible gateway on Cloudflare Workers at https://ai.jugginai.net.

Every route requires `Authorization: Bearer <AI_PROXY_TOKEN>`; anything else gets `401`.

## Routes

| Route | What it does |
| --- | --- |
| `GET /v1/models` | Cloud model lists (xAI, OpenAI, OpenRouter, Venice, Hugging Face, Google, Anthropic) merged with live PC models from the PC bridge (`/models/installed` + `/health`). Each model has `status`: `online`, `standby`, or `offline`. |
| `POST /v1/chat/completions` | Routes by model prefix: `xai/`, `openai/`, `openrouter/`, `venice/`, `hf/`, `anthropic/`, `google/`, `local-lmstudio/`, `local-llamacpp/`. SSE streaming passthrough, multimodal `image_url` blocks. `venice/qwen-2.5-vl` maps to Venice's current vision model. |
| `POST /v1/embeddings` | PC `nomic-embed-text-v1.5` via the bridge, then OpenAI `text-embedding-3-small` (768 dims), then Gemini `gemini-embedding-001` (768 dims). |
| `POST /v1/images/generations` | Venice image generation. Passes `model`, `negative_prompt`, `style_preset`, `steps`, `cfg_scale`, `seed`, `width`, `height`. OpenAI-shaped `b64_json` response. |
| `POST /v1/audio/speech` | Venice `tts-kokoro` with `voice` and `speed`. Returns `audio/mpeg`. |
| `ALL /v1/pc/*` | Authenticated passthrough to the PC bridge (`PC_BRIDGE_URL`). `503` JSON when it's offline. |
| `/v1/tools/brave-search` | Brave web/news/images search (`q`, `count`, `type`). |
| `/v1/tools/context7/search`, `/v1/tools/context7/docs` | Context7 library search and docs (`libraryId`, `query`). |
| `/v1/tools/pinecone/query`, `/v1/tools/pinecone/upsert` | Pinecone (`jugginai-rag`, 768 dims). Accepts raw `vector(s)` or `text`/`records` to embed. |
| `/v1/tools/rag/ingest`, `/v1/tools/rag/query` | Document RAG: stores text in R2 bucket `jugginai` under `rag/`, chunks, embeds, upserts to Pinecone. Namespaces are per embedding model. |
| `/v1/tools/composio/*` | Passthrough to Composio API v3. |
| `/v1/tools/linear` | Linear GraphQL (`{ query, variables }`). |
| `GET /v1/providers` | Which providers and tools are configured (no secret values). |
| `/openai/*`, `/grok/*` | Legacy passthrough via the `jugginai` AI Gateway. |

Hugging Face calls go to `router.huggingface.co` and always send `X-HF-Bill-To: DavesTrapHouse`.

A provider whose key is not set answers `503 {"error":{"type":"not_configured","missing":"<KEY>"}}`.

## Observability

Every request is traced to Langfuse US (`LANGFUSE_BASE_URL=https://us.cloud.langfuse.com`) over OpenTelemetry (`/api/public/otel/v1/traces`), in the background via `ctx.waitUntil`. Traces carry tags `service:jugginai-ai-proxy` and `provider:<name>`, plus model, latency, token usage, and tool calls.

## Secrets

Set with `wrangler secret put` from 1Password, never committed:

`AI_PROXY_TOKEN`, `CF_AIG_AUTHORIZATION`, `XAI_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `VENICE_API_KEY`, `HF_TOKEN`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`, `BRAVE_API_KEY`, `CONTEXT7_API_KEY`, `PINECONE_API_KEY`, `COMPOSIO_API_KEY`, `LINEAR_API_KEY`, `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `PC_BRIDGE_TOKEN`.

```sh
op read "op://API Keys/<item>/<field>" | pnpm wrangler secret put NAME
pnpm deploy
```
