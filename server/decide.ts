import { clearSessionCookie, crossSite, header, json, sessionFrom, WALLET_URL, type AuthConfig, type HttpRequest, type HttpResponse } from './auth.ts';
import type { SessionData } from './session.ts';

export const JEV_MODEL = 'typesafe/jev-1.13.0';

export interface DecideDeps {
  apiKey: string | undefined;
  baseUrl: string;
  fetch: typeof fetch;
  now: () => number;
  timeoutMs?: number;
  log?: (line: string) => void;
  keyMode?: 'player' | 'dev';
}

export interface DecideResult {
  status: number;
  body: unknown;
}

interface DecideInput {
  state: unknown;
  questions: Record<string, unknown>;
}

function isDecideInput(v: unknown): v is DecideInput {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return o.state !== undefined && !!o.questions && typeof o.questions === 'object' && Object.keys(o.questions).length > 0;
}

function upstreamMessage(text: string): string {
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    if (typeof parsed.error === 'string') return parsed.error;
  } catch {
    // not JSON; use the raw text
  }
  return text.slice(0, 200);
}

export async function handleDecide(input: unknown, deps: DecideDeps): Promise<DecideResult> {
  const apiKey = deps.apiKey;
  const redact = (s: string): string => (apiKey ? s.split(apiKey).join('[redacted]') : s);
  const rawLog = deps.log ?? (() => {});
  const log = (line: string): void => rawLog(redact(line));
  const tag = deps.keyMode ? `[jev ${deps.keyMode}]` : '[jev]';
  const timeoutMs = deps.timeoutMs ?? 2000;
  if (!deps.apiKey) return { status: 500, body: { error: 'No OPPER_API_KEY in .env — all decisions are fallbacks' } };
  if (!isDecideInput(input)) return { status: 400, body: { error: 'Expected { state, questions } with at least one question' } };

  const actors = Object.keys(input.questions).join(',');
  const started = deps.now();
  try {
    const res = await deps.fetch(`${deps.baseUrl.replace(/\/+$/, '')}/v3/compat/v1/systemone`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${deps.apiKey}`,
        'Content-Type': 'application/json',
        'X-Opper-Name': 'jevman-decide',
      },
      body: JSON.stringify({ model: JEV_MODEL, state: input.state, questions: input.questions }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    const latencyMs = Math.round(deps.now() - started);
    if (!res.ok) {
      const error = redact(`jev returned HTTP ${res.status}: ${upstreamMessage(text)}`);
      log(`${tag} ${actors} failed after ${latencyMs} ms — ${error}`);
      if (deps.keyMode === 'player') {
        if (res.status === 401) return { status: 401, body: { error: 'Your Opper sign-in has expired — sign in again', signedOut: true, clearSession: true } };
        if (res.status === 402) return { status: 402, body: { error: 'Your Opper wallet is empty — top up to keep playing', walletUrl: WALLET_URL } };
        if (res.status === 403) return { status: 403, body: { error: 'jev is not enabled for your Opper account' } };
      }
      return { status: 502, body: { error } };
    }
    const json = JSON.parse(text) as { answers?: Record<string, unknown>; usage?: { input_tokens: number; output_tokens: number } };
    const cost = res.headers.get('x-opper-cost');
    const traceId = res.headers.get('x-opper-trace-id');
    log(`${tag} ${actors} ok in ${latencyMs} ms, cost ${cost ?? '?'} USD, trace ${traceId ?? '?'}`);
    return {
      status: 200,
      body: {
        answers: json.answers ?? {},
        usage: json.usage ?? { input_tokens: 0, output_tokens: 0 },
        latencyMs,
        costUsd: cost === null ? null : Number(cost),
        traceId,
      },
    };
  } catch (err) {
    const e = err as Error;
    const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError';
    const error = timedOut ? `jev timed out after ${timeoutMs} ms` : redact(`jev request failed: ${e?.message ?? String(err)}`);
    log(`${tag} ${actors} ${error}`);
    return { status: timedOut ? 504 : 502, body: { error } };
  }
}

/** The key a decide call uses: the signed-in player's, else the local dev key, else none. */
export function resolveKey(session: SessionData | null, devKey?: string): { apiKey: string; mode: 'player' | 'dev' } | null {
  if (session) return { apiKey: session.apiKey, mode: 'player' };
  if (devKey) return { apiKey: devKey, mode: 'dev' };
  return null;
}

export interface DecideRequestDeps {
  fetch: typeof fetch;
  now: () => number;
  log?: (line: string) => void;
  logError?: (line: string) => void;
}

/**
 * The answer to a /api/decide request that is refused before its body matters, or null to go ahead:
 * 405 for anything but POST, 403 cross-site, 415 unless JSON (a cross-site form can post text/plain
 * without a CORS preflight), and 401 `signedOut` when there is neither a session nor a dev key.
 */
export function rejectDecideRequest(req: HttpRequest, cfg: AuthConfig, devKey: string | undefined): HttpResponse | null {
  if (req.method !== 'POST') return json(405, { error: 'POST only' }, [], { Allow: 'POST' });
  if (crossSite(req)) return json(403, { error: 'Cross-site request refused' });
  if (!header(req, 'content-type').toLowerCase().startsWith('application/json')) return json(415, { error: 'Expected application/json' });
  if (!resolveKey(sessionFrom(req, cfg), devKey)) return json(401, { error: 'Sign in with Opper to let jev play', signedOut: true });
  return null;
}

/** /api/decide, independent of the HTTP server: picks the key, calls jev, and turns `clearSession` into a Set-Cookie. */
export async function handleDecideRequest(req: HttpRequest, rawBody: string, cfg: AuthConfig, devKey: string | undefined, deps: DecideRequestDeps): Promise<HttpResponse> {
  const refused = rejectDecideRequest(req, cfg, devKey);
  if (refused) return refused;
  const key = resolveKey(sessionFrom(req, cfg), devKey)!;
  const redact = (s: string) => [key.apiKey, devKey].reduce<string>((acc, k) => (k ? acc.split(k).join('[redacted]') : acc), s);
  try {
    let input: unknown = null;
    try {
      input = JSON.parse(rawBody);
    } catch {
      // handled as a 400 by handleDecide
    }
    const result = await handleDecide(input, { apiKey: key.apiKey, keyMode: key.mode, baseUrl: cfg.opperUrl, fetch: deps.fetch, now: deps.now, log: deps.log });
    const { clearSession, ...body } = result.body as Record<string, unknown>;
    return json(result.status, body, clearSession ? [clearSessionCookie(cfg)] : []);
  } catch (err) {
    deps.logError?.(`[jev] /api/decide failure: ${redact((err as Error)?.message ?? String(err))}`);
    return json(500, { error: 'internal error in /api/decide' });
  }
}
