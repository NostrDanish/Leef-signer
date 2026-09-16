# LEEF Trader ↔ AI gateway — integration contract

This is the contract between [LEEF Trader](https://github.com/NostrDanish/leef-trader)
and a Worker deployed by this tool (default name `leef-trader-ai`).

## Endpoint

```
POST https://<your-worker>.workers.dev/api/ai
Content-Type: application/json
```

LEEF Trader needs **no API key and no PPQ key**. Point it at the Worker URL only
(e.g. an `AI_GATEWAY_URL` setting). The PPQ credential (`PPQ_API_KEY`) lives
exclusively in the Cloudflare Worker secret store.

Built-in diagnostics:

- `GET /api/health` — probes the upstream provider key (returns 200/207).
- `GET /api/status` — non-secret status (configured providers/routes).

## Request

Two shapes are accepted:

**A) Task shorthand (preferred for LEEF Trader):**

```json
{
  "task": "market_analysis",
  "message": "optional free-text context (≤ 8 KB)",
  "data": { "…": "compact structured payload (≤ 32 KB serialized)" }
}
```

Known tasks: `market_analysis`, `strategy_analysis`, `opportunity_explanation`,
`post_trade_analysis`, `evidence_review`, `health_check`. Unknown tasks are still
answered (the model notes the unknown task in `warnings`).

**B) Raw chat:** `{ "messages": [{ "role": "user", "content": "…" }] }`
(max 20 messages, 24 KB each, 64 KB total; client `system` messages are always
stripped and replaced by the server prompt).

Never send private keys, session keys, seed phrases, or any secrets. Aggregate
before sending: features + statistics + a few recent examples, not raw history.

## Response

HTTP 200 with the upstream chat completion. The analysis JSON is at
`choices[0].message.content` (the gateway forces `response_format: json_object`):

```json
{
  "assessment": "supportive | neutral | cautious | concerned",
  "confidence": 0.0,
  "observations": ["observed facts tied to the supplied data"],
  "warnings": ["risks, data gaps, insufficient_evidence flags"],
  "suggestions": [{ "type": "investigate | calibrate | monitor", "area": "…", "reason": "…" }],
  "patterns": [{ "failure_code": "MIN_OUT_FAILED", "count": 3, "interpretation": "economic" }],
  "trade_authorization": false
}
```

`trade_authorization` is always `false` — the AI has no execution authority.
The deterministic engine (exact quote → economic gate → risk → policy firewall)
remains authoritative. AI output is soft information only.

## Failure modes (fail-safe by design)

| Condition | HTTP | Body |
|---|---|---|
| PPQ slow / down (> 10 s) | 504 | `{"error":{"code":"PROVIDER_TIMEOUT", …}}` |
| PPQ unreachable / 5xx | 502 | `PROVIDER_UNAVAILABLE` / `UPSTREAM_ERROR` |
| PPQ key rejected | 502 | `UPSTREAM_ERROR` ("credential was rejected") |
| Rate limit (> 20/min per IP) | 429 | `RATE_LIMITED` (+ `Retry-After`) |
| Bad body / oversize | 400 | `INVALID_REQUEST` / `PAYLOAD_TOO_LARGE` |

Any non-200 ⇒ AI unavailable ⇒ keep trading deterministically. The upstream
timeout is 10 s by configuration, so AI can never stall the trading loop.

## Hard guarantees (enforced server-side)

- Fixed upstream (`https://api.ppq.ai/v1`) — no arbitrary URLs, no open proxy.
- Server-controlled model; client `model` is ignored unless explicitly
  allowlisted by the operator (default: not allowlisted).
- Server-controlled system prompt; client system prompts are stripped.
- CORS reflect-allowlist: `https://leef-trader.vercel.app`,
  `https://leef-trader.shakespeare.wtf` (preflight from other origins → 403).
- 256 KB request cap; sanitized errors (upstream bodies never forwarded).
- `provider.zdr: true` — PPQ routes to Zero-Data-Retention providers where
  supported.

## Operating the model

The model is a plain-text Worker var, **`PPQ_MODEL`**, changeable from the
Cloudflare dashboard (Workers → leef-trader-ai → Settings → Variables) without
redeploying:

- `deepseek/deepseek-v4-flash` — default
- `deepseek/deepseek-v4-flash:floor` — cheapest-provider routing
- `deepseek/deepseek-v4-flash:nitro` — highest-throughput routing

Pick models from the live catalog (`GET https://api.ppq.ai/v1/models`); prefer
`privacyLevel: "zdr"` entries to keep ZDR routing effective. Very small models
were observed to invent data — do not downgrade below flash-class reasoning.

**ZDR note:** `provider.zdr: true` constrains PPQ to its Zero-Data-Retention
provider pool, which is smaller and can be intermittently slow — during such
windows the gateway answers `504 PROVIDER_TIMEOUT` within 10 s and LEEF Trader
simply continues without analysis. If you would rather trade privacy for
availability, redeploy with `extraBody: {}` (drop the `provider.zdr` flag) from
the wizard's Providers step.

## Cadence guidance

Call the AI event-driven, not per-trade: every N decisions, on regime change,
on repeated failure clusters, on large predicted-vs-realized divergence, or on
manual review. The 20 req/min ceiling assumes batching; a few calls per hour is
the intended operating point (≈ $0.00015 per call at current PPQ pricing).
