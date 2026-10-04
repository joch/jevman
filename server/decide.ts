import { clearSessionCookie, crossSite, header, json, sessionFrom, WALLET_URL, type AuthConfig, type HttpRequest, type HttpResponse } from './auth.ts';
import { endpointFor, modelFor, TYPESAFE_USD_PER_INPUT_TOKEN, type JevProvider, type JevTarget } from './jev.ts';
import type { SessionData } from './session.ts';

export const JEV_MODEL = modelFor('opper');

export interface DecideDeps {
  apiKey: string | undefined;
  baseUrl: string;
  fetch: typeof fetch;
  now: () => number;
  timeoutMs?: number;
  log?: (line: string) => void;
  keyMode?: 'player' | 'dev';
  /** Which System One API `baseUrl` points at (default Opper). */
  provider?: JevProvider;
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
  const provider = deps.provider ?? 'opper';
  const tag = `[${['jev', deps.keyMode, provider === 'typesafe' ? 'typesafe' : undefined].filter(Boolean).join(' ')}]`;
  const timeoutMs = deps.timeoutMs ?? 2000;
  if (!deps.apiKey) return { status: 500, body: { error: 'No TYPESAFE_API_KEY or OPPER_API_KEY in .env — all decisions are fallbacks' } };
  if (!isDecideInput(input)) return { status: 400, body: { error: 'Expected { state, questions } with at least one question' } };

  const actors = Object.keys(input.questions).join(',');
  const started = deps.now();
  try {
    const res = await deps.fetch(endpointFor({ provider, apiKey: deps.apiKey, baseUrl: deps.baseUrl }), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${deps.apiKey}`,
        'Content-Type': 'application/json',
        ...(provider === 'opper' ? { 'X-Opper-Name': 'jevman-decide' } : {}),
      },
      body: JSON.stringify({ model: modelFor(provider), state: input.state, questions: input.questions }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    const latencyMs = Math.round(deps.now() - started);
    if (!res.ok) {
      const error = redact(`jev returned HTTP ${res.status}: ${upstreamMessage(redact(text))}`);
      log(`${tag} ${actors} failed after ${latencyMs} ms — ${error}`);
      if (deps.keyMode === 'player') {
        if (res.status === 401) return { status: 401, body: { error: 'Your Opper sign-in has expired — sign in again', signedOut: true, clearSession: true } };
        if (res.status === 402) return { status: 402, body: { error: 'Your Opper wallet is empty — top up to keep playing', walletUrl: WALLET_URL } };
        if (res.status === 403) return { status: 403, body: { error: 'jev is not enabled for your Opper account' } };
      }
      return { status: 502, body: { error } };
    }
    const json = JSON.parse(text) as { answers?: Record<string, unknown>; usage?: { input_tokens: number; output_tokens: number } };
    const usage = json.usage ?? { input_tokens: 0, output_tokens: 0 };
    if (provider === 'typesafe') {
      // TypeSafe sends no cost header; estimate from its published input-token price.
      const tokens = Number(json.usage?.input_tokens);
      const costUsd = Number.isFinite(tokens) ? tokens * TYPESAFE_USD_PER_INPUT_TOKEN : null;
      const requestId = res.headers.get('x-typesafe-request-id');
      log(`${tag} ${actors} ok in ${latencyMs} ms, cost ${costUsd === null ? '?' : `≈${Number(costUsd.toPrecision(2))}`} USD, request ${requestId ?? '?'}`);
      return { status: 200, body: { answers: json.answers ?? {}, usage, latencyMs, costUsd, costEstimated: true, traceId: requestId } };
    }
    const cost = res.headers.get('x-opper-cost');
    const traceId = res.headers.get('x-opper-trace-id');
    log(`${tag} ${actors} ok in ${latencyMs} ms, cost ${cost ?? '?'} USD, trace ${traceId ?? '?'}`);
    return {
      status: 200,
      body: {
        answers: json.answers ?? {},
        usage,
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

/** Where a decide call goes: the signed-in player's key (always via Opper), else the server's dev key, else nowhere. */
export function resolveKey(session: SessionData | null, devKey: JevTarget | undefined, opperUrl: string): (JevTarget & { mode: 'player' | 'dev' }) | null {
  if (session) return { provider: 'opper', apiKey: session.apiKey, baseUrl: opperUrl, mode: 'player' };
  if (devKey) return { ...devKey, mode: 'dev' };
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
export function rejectDecideRequest(req: HttpRequest, cfg: AuthConfig, devKey: JevTarget | undefined): HttpResponse | null {
  if (req.method !== 'POST') return json(405, { error: 'POST only' }, [], { Allow: 'POST' });
  if (crossSite(req)) return json(403, { error: 'Cross-site request refused' });
  if (!header(req, 'content-type').toLowerCase().startsWith('application/json')) return json(415, { error: 'Expected application/json' });
  if (!resolveKey(sessionFrom(req, cfg), devKey, cfg.opperUrl)) return json(401, { error: 'Sign in with Opper to let jev play', signedOut: true });
  return null;
}

/** /api/decide, independent of the HTTP server: picks the key, calls jev, and turns `clearSession` into a Set-Cookie. */
export async function handleDecideRequest(req: HttpRequest, rawBody: string, cfg: AuthConfig, devKey: JevTarget | undefined, deps: DecideRequestDeps): Promise<HttpResponse> {
  const refused = rejectDecideRequest(req, cfg, devKey);
  if (refused) return refused;
  const key = resolveKey(sessionFrom(req, cfg), devKey, cfg.opperUrl)!;
  const redact = (s: string) => [key.apiKey, devKey?.apiKey].reduce<string>((acc, k) => (k ? acc.split(k).join('[redacted]') : acc), s);
  try {
    let input: unknown = null;
    try {
      input = JSON.parse(rawBody);
    } catch {
      // handled as a 400 by handleDecide
    }
    const result = await handleDecide(input, { apiKey: key.apiKey, keyMode: key.mode, provider: key.provider, baseUrl: key.baseUrl, fetch: deps.fetch, now: deps.now, log: deps.log });
    const { clearSession, ...body } = result.body as Record<string, unknown>;
    return json(result.status, body, clearSession ? [clearSessionCookie(cfg)] : []);
  } catch (err) {
    deps.logError?.(`[jev] /api/decide failure: ${redact((err as Error)?.message ?? String(err))}`);
    return json(500, { error: 'internal error in /api/decide' });
  }
}
