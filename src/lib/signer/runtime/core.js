/**
 * Signer runtime core — dependency-free primitives that ship inside the
 * generated Cloudflare Worker.
 *
 * IMPORTANT: this file is serialized verbatim into the worker by
 * `generator.ts`. It must therefore:
 *   - have NO imports,
 *   - use NO Node/DOM-only APIs (Worker runtime only).
 *
 * It is authored as **plain JavaScript** (not TypeScript) on purpose: the
 * Cloudflare script-upload API does not transpile TypeScript, so the generated
 * worker must be valid ECMAScript byte-for-byte. Types are documented with
 * JSDoc instead.
 *
 * @typedef {Object} RateRule
 * @property {'ip'|'api-key'|'header'|'nostr-pubkey'} keyBy
 * @property {string} [headerName]
 * @property {number} requestsPerMinute
 *
 * @typedef {Object} RuntimeManifest
 * @property {'1'} version
 * @property {string} app
 * @property {{ allowedOrigins: string[], publicAuth: {type:'none'}|{type:'api-key',secretName:string}|{type:'nip98'}, internalMode: boolean }} security
 * @property {{ default: RateRule, perRoute: Record<string, RateRule> }} limits
 * @property {{ mode: 'standard'|'privacy'|'maximum' }} privacy
 * @property {Record<string, string>} routes
 * @property {Record<string, Record<string, unknown>>} providers
 *
 * @typedef {Record<string, unknown>} WorkerEnv
 */

/* ------------------------------------------------------------------ */
/* Standard error model — never leak internals                        */
/* ------------------------------------------------------------------ */

/**
 * @typedef {'INVALID_REQUEST'|'UNAUTHORIZED'|'FORBIDDEN'|'RATE_LIMITED'|'PROVIDER_UNAVAILABLE'|'PROVIDER_TIMEOUT'|'UPSTREAM_ERROR'|'CONFIGURATION_ERROR'|'SSRF_BLOCKED'|'PAYLOAD_TOO_LARGE'|'METHOD_NOT_ALLOWED'|'NOT_FOUND'|'INTERNAL'} ErrorCode
 */

/**
 * @param {ErrorCode} code
 * @param {string} message
 * @param {string} requestId
 * @returns {string}
 */
export function errorBody(code, message, requestId) {
  return JSON.stringify({ error: { code, message, requestId } });
}

/** @returns {string} */
export function makeRequestId() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

/* ------------------------------------------------------------------ */
/* CORS — reflect allowlisted origins only, never "*" unless public   */
/* ------------------------------------------------------------------ */

/**
 * Exact origins are reflected verbatim; entries of the form
 * "https://*.example.com" match any subdomain of example.com (useful for
 * preview/hosting deployments). The bare apex is NOT matched by a wildcard.
 *
 * @param {Request} request
 * @param {string[]} allowed
 * @returns {string | null}
 */
export function corsAllowOrigin(request, allowed) {
  const origin = request.headers.get('Origin');
  if (!origin) return null; // same-origin / non-browser
  if (allowed.includes('*')) return '*';
  if (allowed.includes(origin)) return origin;

  // Wildcard-subdomain pass.
  let host = '';
  try {
    host = new URL(origin).hostname.toLowerCase();
  } catch {
    // Defensive fallback if the URL parser rejects an odd origin.
    const m = origin.toLowerCase();
    const schemeIdx = m.indexOf('://');
    host = (schemeIdx >= 0 ? m.slice(schemeIdx + 3) : m).split('/')[0].split(':')[0];
  }
  if (!host) return null;
  for (const entry of allowed) {
    const e = entry.toLowerCase();
    const schemeIdx = e.indexOf('://');
    const entryHost = (schemeIdx >= 0 ? e.slice(schemeIdx + 3) : e).split('/')[0];
    if (!entryHost.startsWith('*.')) continue;
    const suffix = entryHost.slice(1); // ".example.com"
    if (host.endsWith(suffix) && host.length > suffix.length) return origin;
  }
  return null;
}

/**
 * @param {Headers} headers
 * @param {Request} request
 * @param {string[]} allowed
 */
export function applyCors(headers, request, allowed) {
  const allow = corsAllowOrigin(request, allowed);
  if (allow) {
    headers.set('Access-Control-Allow-Origin', allow);
    headers.append('Vary', 'Origin');
  }
}

/**
 * @param {Request} request
 * @param {string[]} allowed
 * @returns {Response}
 */
export function handlePreflight(request, allowed) {
  const allow = corsAllowOrigin(request, allowed);
  if (!allow) return new Response(null, { status: 403 });
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': allow,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin',
    },
  });
}

/**
 * @param {unknown} data
 * @param {number} status
 * @param {Request} request
 * @param {string[]} allowed
 * @returns {Response}
 */
export function jsonResponse(data, status, request, allowed) {
  const headers = new Headers({
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  });
  applyCors(headers, request, allowed);
  return new Response(JSON.stringify(data), { status, headers });
}

/**
 * @param {ErrorCode} code
 * @param {string} message
 * @param {number} status
 * @param {Request} request
 * @param {string[]} allowed
 * @param {string} requestId
 * @param {number} [retryAfterSeconds]
 * @returns {Response}
 */
export function errorResponse(code, message, status, request, allowed, requestId, retryAfterSeconds) {
  const headers = new Headers({
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  });
  applyCors(headers, request, allowed);
  if (retryAfterSeconds !== undefined) headers.set('Retry-After', String(retryAfterSeconds));
  return new Response(errorBody(code, message, requestId), { status, headers });
}

/* ------------------------------------------------------------------ */
/* Public gateway auth (distinct from upstream provider secrets)      */
/* ------------------------------------------------------------------ */

/**
 * @param {Request} request
 * @param {RuntimeManifest} manifest
 * @param {WorkerEnv} env
 * @returns {boolean}
 */
export function checkPublicAuth(request, manifest, env) {
  const auth = manifest.security.publicAuth;
  if (auth.type === 'none') return true;
  if (auth.type === 'nip98') return true; // structural NIP-98 check is per-route; presence-only here
  const expected = env[auth.secretName];
  if (typeof expected !== 'string' || expected.length === 0) return false;
  const header = request.headers.get('Authorization') ?? '';
  const apiKey = request.headers.get('X-API-Key') ?? '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
  return bearer === expected || apiKey === expected;
}

/* ------------------------------------------------------------------ */
/* Rate limiting (best-effort per isolate; upgrade path: CF binding)  */
/* ------------------------------------------------------------------ */

/** @type {Map<string, { count: number, resetAt: number }>} */
const buckets = new Map();

/**
 * @param {Request} request
 * @param {RateRule} rule
 * @returns {string}
 */
export function identityKey(request, rule) {
  switch (rule.keyBy) {
    case 'api-key':
      return `k:${request.headers.get('X-API-Key') ?? request.headers.get('Authorization') ?? 'anon'}`;
    case 'header':
      return `h:${rule.headerName ?? ''}:${request.headers.get(rule.headerName ?? '') ?? 'anon'}`;
    case 'nostr-pubkey':
      return `n:${request.headers.get('X-Nostr-Pubkey') ?? 'anon'}`;
    case 'ip':
    default:
      return `i:${request.headers.get('CF-Connecting-IP') ?? 'anon'}`;
  }
}

/**
 * @param {Request} request
 * @param {RateRule} rule
 * @param {string} routePath
 * @returns {number} seconds until reset if limited, else 0.
 */
export function rateLimit(request, rule, routePath) {
  const key = `${routePath}|${identityKey(request, rule)}`;
  const now = Date.now();
  const entry = buckets.get(key);
  if (!entry || now > entry.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + 60_000 });
    if (buckets.size > 10_000) buckets.clear();
    return 0;
  }
  entry.count++;
  if (entry.count > rule.requestsPerMinute) {
    return Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
  }
  return 0;
}

/* ------------------------------------------------------------------ */
/* SSRF guard — validate crawl/fetch targets                          */
/* ------------------------------------------------------------------ */

/**
 * @param {string} ip
 * @returns {number | null}
 */
function ipv4ToInt(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let out = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    out = out * 256 + n;
  }
  return out >>> 0;
}

/**
 * @param {string} ip
 * @returns {boolean}
 */
function isPrivateIpv4(ip) {
  const n = ipv4ToInt(ip);
  if (n === null) return false;
  /**
   * @param {string} base
   * @param {number} bits
   * @returns {boolean}
   */
  const inRange = (base, bits) => {
    const b = ipv4ToInt(base);
    if (b === null) return false;
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (n & mask) === (b & mask);
  };
  return (
    inRange('127.0.0.0', 8) ||
    inRange('10.0.0.0', 8) ||
    inRange('172.16.0.0', 12) ||
    inRange('192.168.0.0', 16) ||
    inRange('169.254.0.0', 16) ||
    inRange('100.64.0.0', 10) ||
    inRange('0.0.0.0', 8)
  );
}

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata.google.internal',
  'instance-data',
  'metadata',
]);

/**
 * Validate a user-supplied target URL (crawler / tor fetch). Blocks
 * localhost, private/link-local IPs, and cloud-metadata hostnames unless
 * the deployment explicitly enables internalMode.
 *
 * @param {string} raw
 * @param {boolean} internalMode
 * @returns {{ ok: boolean, reason?: string }}
 */
export function checkTargetUrl(raw, internalMode) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'Target must be a valid URL' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, reason: 'Target must be http(s)' };
  }
  const host = url.hostname.toLowerCase();
  if (internalMode) return { ok: true };

  if (BLOCKED_HOSTNAMES.has(host) || host.endsWith('.internal') || host.endsWith('.local')) {
    return { ok: false, reason: 'Target host is blocked' };
  }
  if (isPrivateIpv4(host)) return { ok: false, reason: 'Target IP is private/reserved' };
  if (host === '::1' || host.startsWith('[')) {
    // IPv6 literal: conservative — only allow if clearly global. Block ULA/loopback/link-local.
    const bare = host.replace(/[[\]]/g, '');
    if (bare === '::1' || bare.startsWith('fe80') || bare.startsWith('fc') || bare.startsWith('fd')) {
      return { ok: false, reason: 'Target IPv6 is private/reserved' };
    }
  }
  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* Misc                                                                */
/* ------------------------------------------------------------------ */

/**
 * @param {Request} request
 * @param {number} maxBytes
 * @returns {Promise<unknown>}
 */
export async function readJsonBody(request, maxBytes) {
  const text = await request.text();
  if (text.length > maxBytes) {
    throw new Error('PAYLOAD_TOO_LARGE');
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('INVALID_JSON');
  }
}

/**
 * @param {unknown} v
 * @returns {string | undefined}
 */
export function asString(v) {
  return typeof v === 'string' ? v : undefined;
}

/**
 * @param {WorkerEnv} env
 * @param {string} name
 * @returns {string | undefined}
 */
export function getSecret(env, name) {
  const v = env[name];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}
