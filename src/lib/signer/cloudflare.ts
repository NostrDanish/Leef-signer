/**
 * Cloudflare REST API client — runs ENTIRELY in the browser.
 *
 * The user's API token is used only for these direct calls and is never
 * written to storage, analytics, logs, or a backend. This is what makes the
 * platform "the machine that creates YOUR API proxy" — not a hosted vault.
 *
 * References:
 *   https://developers.cloudflare.com/api/
 *   https://developers.cloudflare.com/workers/configuration/secrets/
 */

export interface CloudflareCredentials {
  accountId: string;
  apiToken: string;
}

const API = 'https://api.cloudflare.com/client/v4';

interface CfEnvelope<T> {
  success: boolean;
  errors: Array<{ code: number; message: string }>;
  result: T;
}

export class CloudflareError extends Error {
  readonly code: number;
  constructor(message: string, code = 0) {
    super(message);
    this.code = code;
    this.name = 'CloudflareError';
  }
}

async function cf<T>(cred: CloudflareCredentials, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${cred.apiToken}`,
      ...(init?.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      ...(init?.headers ?? {}),
    },
  }).catch(() => {
    throw new CloudflareError('Could not reach the Cloudflare API (network error)');
  });

  let data: CfEnvelope<T>;
  try {
    data = (await res.json()) as CfEnvelope<T>;
  } catch {
    throw new CloudflareError(`Unexpected Cloudflare response (HTTP ${res.status})`);
  }
  if (!data.success) {
    const msg = data.errors?.[0]?.message ?? `Cloudflare error (HTTP ${res.status})`;
    throw new CloudflareError(msg, data.errors?.[0]?.code ?? res.status);
  }
  return data.result;
}

/* ------------------------------------------------------------------ */
/* Token / account verification                                        */
/* ------------------------------------------------------------------ */

export interface VerifyResult {
  tokenValid: boolean;
  tokenStatus: string;
  accountName: string;
  /** Human-readable permission gaps (best-effort). */
  notes: string[];
}

export async function verifyCredentials(cred: CloudflareCredentials): Promise<VerifyResult> {
  const notes: string[] = [];

  // 1. Token validity. Account-scoped tokens cannot call /user/tokens/verify
  //    (it is a user-level endpoint), so try the account-scoped verify first.
  let tokenValid = false;
  let tokenStatus = 'unknown';
  try {
    const t = await cf<{ id: string; status: string }>(cred, `/accounts/${cred.accountId}/tokens/verify`);
    tokenStatus = t.status;
    tokenValid = t.status === 'active';
  } catch {
    try {
      const t = await cf<{ id: string; status: string }>(cred, '/user/tokens/verify');
      tokenStatus = t.status;
      tokenValid = t.status === 'active';
    } catch {
      notes.push('Token verify endpoints unavailable for this token type — relying on the permission probes below');
    }
  }
  if (tokenStatus !== 'unknown' && !tokenValid) notes.push(`Token status is "${tokenStatus}" (expected "active")`);

  // 2. Account readability.
  let accountName = '';
  try {
    const account = await cf<{ name: string }>(cred, `/accounts/${cred.accountId}`);
    accountName = account.name;
  } catch (e) {
    notes.push('Token cannot read this Account ID — check both the ID and token scope');
    throw e instanceof CloudflareError ? e : new CloudflareError('Account lookup failed');
  }

  // 3. Workers write permission — attempt a harmless read of the scripts list.
  let workersOk = true;
  try {
    await cf<unknown>(cred, `/accounts/${cred.accountId}/workers/scripts?per_page=1`);
  } catch {
    workersOk = false;
    notes.push('Token lacks "Workers Scripts:Read" — deployments will fail');
  }

  // If the token couldn't be verified directly but proves it can read the
  // account and the workers scripts list, it is good enough to deploy with.
  if (!tokenValid && workersOk && accountName) {
    tokenValid = true;
    notes.push('Account-scoped token confirmed via permission probes');
  }

  return { tokenValid, tokenStatus, accountName, notes };
}

/* ------------------------------------------------------------------ */
/* Worker deployment                                                   */
/* ------------------------------------------------------------------ */

export interface DeployResult {
  scriptName: string;
  /** e.g. my-signer.user.workers.dev (once enabled). */
  workersDevHost: string | null;
}

/** Upload (create or update) a module-syntax Worker from source. */
export async function uploadWorker(
  cred: CloudflareCredentials,
  scriptName: string,
  source: string,
  compatibilityDate: string,
  vars?: Record<string, string>,
): Promise<void> {
  // Non-secret plain-text bindings (e.g. a model override var like PPQ_MODEL).
  const bindings = Object.entries(vars ?? {})
    .filter(([name, value]) => /^[A-Z][A-Z0-9_]*$/.test(name) && value.length > 0)
    .map(([name, text]) => ({ name, type: 'plain_text', text }));
  const metadata: Record<string, unknown> = {
    main_module: 'worker.mjs',
    compatibility_date: compatibilityDate,
  };
  if (bindings.length > 0) metadata.bindings = bindings;

  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  // The generated source is plain JavaScript (see runtime/*.js) — Cloudflare
  // does not transpile TypeScript on upload.
  form.append('worker.mjs', new Blob([source], { type: 'application/javascript+module' }), 'worker.mjs');

  await cf<unknown>(cred, `/accounts/${cred.accountId}/workers/scripts/${encodeURIComponent(scriptName)}`, {
    method: 'PUT',
    body: form,
  });
}

/** Add/update a single Worker secret. Value goes straight to CF, never stored. */
export async function putSecret(
  cred: CloudflareCredentials,
  scriptName: string,
  name: string,
  text: string,
): Promise<void> {
  await cf<unknown>(
    cred,
    `/accounts/${cred.accountId}/workers/scripts/${encodeURIComponent(scriptName)}/secrets`,
    {
      method: 'PUT',
      body: JSON.stringify({ name, text, type: 'secret_text' }),
    },
  );
}

/** Best-effort: ensure the workers.dev subdomain is enabled and read the host. */
export async function enableWorkersDev(
  cred: CloudflareCredentials,
  scriptName: string,
): Promise<string | null> {
  // Get the account's workers.dev subdomain (may 404 if never claimed).
  let subdomain: string | null = null;
  try {
    const s = await cf<{ subdomain: string }>(cred, `/accounts/${cred.accountId}/workers/subdomain`);
    subdomain = s.subdomain;
  } catch {
    // No workers.dev subdomain yet — try to claim one derived from the
    // script name. (If the token lacks the scope, the deploy still succeeds;
    // the user can claim a subdomain in the dashboard later.)
    const claim = scriptName.toLowerCase().replace(/[^a-z0-9-]/g, '').replace(/^(?:-+)|(?:-+)$/g, '') || 'edge-signer';
    try {
      const s = await cf<{ subdomain: string }>(cred, `/accounts/${cred.accountId}/workers/subdomain`, {
        method: 'PUT',
        body: JSON.stringify({ subdomain: claim }),
      });
      subdomain = s.subdomain;
    } catch {
      subdomain = null;
    }
  }

  // Enable the script on workers.dev.
  try {
    await cf<unknown>(
      cred,
      `/accounts/${cred.accountId}/workers/scripts/${encodeURIComponent(scriptName)}/subdomain`,
      { method: 'POST', body: JSON.stringify({ enabled: true }) },
    );
  } catch {
    // Non-fatal: token may lack the permission; deployment still succeeded.
  }

  return subdomain ? `${scriptName}.${subdomain}.workers.dev` : null;
}

/** Full deploy: upload source (+ non-secret vars), push secrets, enable workers.dev. */
export async function deployWorker(
  cred: CloudflareCredentials,
  scriptName: string,
  source: string,
  secrets: Record<string, string>,
  compatibilityDate: string,
  onProgress?: (step: string) => void,
  vars?: Record<string, string>,
): Promise<DeployResult> {
  onProgress?.('Uploading worker');
  await uploadWorker(cred, scriptName, source, compatibilityDate, vars);

  const entries = Object.entries(secrets).filter(([, v]) => v.length > 0);
  for (let i = 0; i < entries.length; i++) {
    const [name, value] = entries[i];
    onProgress?.(`Storing secret ${i + 1}/${entries.length}`);
    await putSecret(cred, scriptName, name, value);
  }

  onProgress?.('Enabling workers.dev');
  const workersDevHost = await enableWorkersDev(cred, scriptName);
  return { scriptName, workersDevHost };
}

/* ------------------------------------------------------------------ */
/* Health check against the deployed worker                            */
/* ------------------------------------------------------------------ */

export interface LiveHealth {
  reachable: boolean;
  ok: boolean;
  checks: Array<{ id: string; ok: boolean; detail: string; latencyMs?: number }>;
  error?: string;
}

export async function checkDeployedHealth(host: string, timeoutMs = 12_000): Promise<LiveHealth> {
  const url = `https://${host}/api/health`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) }).catch(() => null);
    if (!res) return { reachable: false, ok: false, checks: [], error: 'unreachable' };
    const data = (await res.json().catch(() => null)) as
      | { ok?: boolean; checks?: LiveHealth['checks'] }
      | null;
    return {
      reachable: true,
      ok: Boolean(data?.ok),
      checks: data?.checks ?? [],
    };
  } catch (e) {
    return { reachable: false, ok: false, checks: [], error: e instanceof Error ? e.message : 'error' };
  }
}
