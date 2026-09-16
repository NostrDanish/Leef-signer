# LEEF Trader Signer

**Bring your own Cloudflare account. Bring your own PPQ API key. Deploy the LEEF Trader AI gateway.**

A one-click deployment tool (fork of [0xSigner](https://github.com/NostrDanish/0xsigner)) that
turns a form into a hardened, rate-limited Cloudflare Worker — preconfigured as the
**AI analysis gateway for [LEEF Trader](https://github.com/NostrDanish/leef-trader)**
([leef-trader.vercel.app](https://leef-trader.vercel.app)).

> **FORM → TEST → DEPLOY → DONE** — as easy as deploying a Nostr relay.

[![Edit with Shakespeare](https://shakespeare.diy/badge.svg)](https://shakespeare.diy/clone?url=https%3A%2F%2Fgithub.com%2FNostrDanish%2FLeef-signer.git)

## What it deploys

```
LEEF Trader (browser)
      │  HTTPS, structured JSON  { task, data }
      ▼
leef-trader-ai (your Cloudflare Worker)
      │  CORS allowlist · 20 req/min · 10s timeout · server-side system prompt
      │  PPQ_API_KEY as a Worker Secret (env.*) — never in code/Git/browser
      ▼
PayPerQ (https://api.ppq.ai) — OpenAI-compatible
      ▼
deepseek/deepseek-v4-flash (ZDR-routed, JSON-mode)
```

The AI is an **analyst, never the trading engine**. It cannot sign, broadcast, or override
deterministic risk controls — the Worker constructs `server system prompt + client data`, forces
the model, and the client can never inject a system prompt or pick an arbitrary model. If PPQ is
down or slow, the Worker returns an error within 10 seconds and LEEF Trader keeps trading
deterministically.

## The principle

This is **the machine that creates _your_ API proxy**, not a hosted proxy that everyone shares.
Every deployment is:

- **your** Cloudflare account and Worker,
- **your** provider API keys — stored as Cloudflare Worker **Secrets** (`env.*`),
  never in code, Git, logs, or the browser bundle,
- **your** routes, CORS allowlist, and rate limits,
- **your** ownership — inspect it or delete it from your own dashboard.

The deployment token is used only for direct browser→Cloudflare API calls and is never stored
or sent anywhere else.

## LEEF Trader preset

Preloaded when you open the wizard (also selectable on the Template step):

| Setting | Value |
|---|---|
| Route | `POST /api/ai` (+ built-in `GET /api/health`, `GET /api/status`) |
| Provider | OpenAI-compatible → `https://api.ppq.ai/v1` |
| Secret | `PPQ_API_KEY` (Worker Secret) |
| Model | `deepseek/deepseek-v4-flash` — cheap, fast, 1M ctx, JSON mode, ZDR-capable (chosen from the live `/v1/models` catalog) |
| Model override | `PPQ_MODEL` plain-text Worker var — change model or routing suffix (`:floor` / `:nitro`) from the Cloudflare dashboard without redeploying |
| Privacy | `provider.zdr: true` (Zero Data Retention routing where PPQ supports it) |
| CORS | `https://leef-trader.vercel.app`, `https://leef-trader.shakespeare.wtf` |
| Rate limit | 20 req/min per IP on `/api/ai` |
| Timeout | 10s upstream — AI can never block the trading loop |
| Response | `response_format: json_object` — always structured JSON with `"trade_authorization": false` |

Request contract: `POST /api/ai` with `{ "task": "market_analysis", "data": { … } }` (or a raw
OpenAI-style `messages` array). Tasks: `market_analysis`, `strategy_analysis`,
`opportunity_explanation`, `post_trade_analysis`, `evidence_review`, `health_check`. The response
is the upstream chat completion — the analysis JSON is in `choices[0].message.content`.

## Beyond LEEF Trader

The LEEF preset is just a manifest — the full generic machinery is intact: AI, search (Brave),
generic REST, IP/geo, indexer, crawler, Tor gateway and multi-provider templates are all still
selectable in the wizard, and you can add more providers and keys to the same worker later.

## Quick start

```bash
npm install
npm run dev
# open http://localhost:8080 — the LEEF Trader preset is preloaded
```

You'll need:

1. A **Cloudflare Account ID** and a restricted **API Token** with
   `Account → Workers Scripts → Edit`.
2. A **PayPerQ API key** (`sk-…` from [ppq.ai](https://ppq.ai)).

The wizard walks you through Application → Cloudflare → Template → Providers → Security →
Limits → Review → Deploy, then hands you a `*.workers.dev` URL and a live health check.

## Docs

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the data flow, provider-adapter model, security
invariants (no open proxy, SSRF guard, secret handling), and the phased roadmap.

## Tech

React 19 · TypeScript · Vite · TailwindCSS 4 · shadcn/ui · zod · Cloudflare Workers REST API

## License

MIT

---

_Vibed with [Shakespeare](https://shakespeare.diy)_
