# jugginai-ai-proxy

Cloudflare Worker that proxies private Grok (xAI) and OpenAI calls through the `jugginai` AI Gateway.

Live: https://ai.jugginai.net

- `POST /grok/...` → Grok via the gateway
- `POST /openai/...` → OpenAI via the gateway

Requests must include `Authorization: Bearer <AI_PROXY_TOKEN>`. Provider keys and the gateway token are Worker secrets, not source.

```sh
pnpm install
pnpm wrangler secret put AI_PROXY_TOKEN
pnpm wrangler secret put OPENAI_API_KEY
pnpm wrangler secret put XAI_API_KEY
pnpm wrangler secret put CF_AIG_AUTHORIZATION
pnpm deploy
```
