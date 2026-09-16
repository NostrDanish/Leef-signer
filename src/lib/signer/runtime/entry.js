/**
 * Worker entry — the single default-export fetch handler. Serialized into
 * the generated module. The MANIFEST const is injected by generator.ts
 * (as a JSON literal) directly before this section.
 *
 * Plain JavaScript on purpose (see core.js): the generated worker must be
 * valid ECMAScript — Cloudflare does not transpile TypeScript on upload.
 */

/* global MANIFEST, makeRequestId, handlePreflight, jsonResponse, errorResponse, applyCors, checkPublicAuth, rateLimit, dispatchProvider, healthCheckProvider */
/* (symbols above are provided by core.js / providers.js / the manifest,   */
/*  concatenated by generator.ts)                                          */

/**
 * Non-secret status — never leaks secrets, only which bindings are set.
 * @param {Record<string, unknown>} env
 * @returns {Record<string, unknown>}
 */
function publicStatus(env) {
  const providers = {};
  for (const [id, cfg] of Object.entries(MANIFEST.providers)) {
    const c = cfg;
    const secretName =
      (typeof c.secretName === 'string' ? c.secretName : undefined) ??
      (c.auth && typeof c.auth === 'object' && typeof c.auth.secretName === 'string'
        ? c.auth.secretName
        : undefined);
    providers[id] = {
      type: c.type,
      configured: secretName ? typeof env[secretName] === 'string' && env[secretName].length > 0 : true,
    };
  }
  return {
    app: MANIFEST.app,
    runtimeVersion: MANIFEST.version,
    routes: Object.keys(MANIFEST.routes),
    providers,
  };
}

export default {
  /**
   * @param {Request} request
   * @param {Record<string, unknown>} env
   * @returns {Promise<Response>}
   */
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const allowed = MANIFEST.security.allowedOrigins;
    const requestId = makeRequestId();

    try {
      if (path.startsWith('/api/') && request.method === 'OPTIONS') {
        return handlePreflight(request, allowed);
      }

      // Built-in status endpoint — never leaks secrets.
      if (path === '/api/status' && request.method === 'GET') {
        return jsonResponse(publicStatus(env), 200, request, allowed);
      }

      // Built-in health endpoint — probes each provider's reachability.
      if (path === '/api/health' && request.method === 'GET') {
        const checks = [];
        for (const [id, cfg] of Object.entries(MANIFEST.providers)) {
          const c = cfg;
          checks.push(await healthCheckProvider(id, String(c.type), c, env));
        }
        const ok = checks.every((c) => c.ok);
        return jsonResponse({ ok, checks }, ok ? 200 : 207, request, allowed);
      }

      const providerId = MANIFEST.routes[path];
      if (!providerId) {
        return errorResponse('NOT_FOUND', 'Unknown route', 404, request, allowed, requestId);
      }
      const cfg = MANIFEST.providers[providerId];
      if (!cfg) {
        return errorResponse('CONFIGURATION_ERROR', 'Route has no provider', 500, request, allowed, requestId);
      }

      // Public gateway auth (separate from upstream provider secrets).
      if (!checkPublicAuth(request, MANIFEST, env)) {
        return errorResponse('UNAUTHORIZED', 'Valid credentials required', 401, request, allowed, requestId);
      }

      // Rate limit: route-specific rule wins, else the default.
      const rule = MANIFEST.limits.perRoute[path] ?? MANIFEST.limits.default;
      const retryAfter = rateLimit(request, rule, path);
      if (retryAfter > 0) {
        return errorResponse('RATE_LIMITED', 'Too many requests', 429, request, allowed, requestId, retryAfter);
      }

      const result = await dispatchProvider(String(cfg.type), {
        request,
        env,
        manifest: MANIFEST,
        allowed,
        requestId,
      }, cfg);
      // Ensure CORS header present even if a provider built its own response.
      applyCors(result.response.headers, request, allowed);
      return result.response;
    } catch {
      // Deliberately opaque: internal errors must not leak config details.
      return errorResponse('INTERNAL', 'Internal error', 500, request, allowed, requestId);
    }
  },
};
