import { DECISION_MODELS, DEFAULT_MODEL } from '../shared/models.ts';
import { randomBytes } from 'node:crypto';
import { openSession, parseCookies, safeEqual, sealSession, serializeCookie, SESSION_MAX_AGE_S, type SessionData } from './session.ts';

export const WALLET_URL = 'https://platform.opper.ai/wallet';
export const SESSION_COOKIE = 'jevman_session';
export const STATE_COOKIE = 'jevman_oauth_state';

export interface AuthConfig {
  clientId?: string;
  clientSecret?: string;
  redirectUri: string;
  opperUrl: string;
  sessionSecret: string;
}

export interface HttpRequest {
  method: string;
  url: string;
  /** Header names are lowercase, as Node's IncomingMessage provides them. */
  headers: Record<string, string | string[] | undefined>;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string | string[]>;
  body: string;
}

export interface Exchanged {
  apiKey: string;
  user: { name?: string; email?: string };
  projectName?: string;
  expiresAt?: string;
}

export type ExchangeCode = (code: string) => Promise<Exchanged>;

export const loginConfigured = (cfg: AuthConfig): boolean => Boolean(cfg.clientId && cfg.clientSecret);
const secure = (cfg: AuthConfig) => cfg.redirectUri.startsWith('https:');
/** A request header by its lowercase name; repeated headers are joined. */
export const header = (req: HttpRequest, name: string): string => {
  const v = req.headers[name];
  return Array.isArray(v) ? v.join('; ') : (v ?? '');
};

/**
 * True when the browser says the request came from another site: `Sec-Fetch-Site` other than `same-origin`,
 * or an `Origin` whose host is not this request's `Host`. Requests without either header (curl, old browsers) pass.
 */
export function crossSite(req: HttpRequest): boolean {
  const site = header(req, 'sec-fetch-site');
  if (site && site !== 'same-origin') return true;
  const origin = header(req, 'origin');
  if (!origin) return false;
  try {
    return new URL(origin).host !== header(req, 'host');
  } catch {
    return true; // e.g. `Origin: null` from a sandboxed frame
  }
}

export const redirect = (location: string, cookies: string[] = []): HttpResponse => ({
  status: 302,
  headers: { Location: location, 'Cache-Control': 'no-store', 'Set-Cookie': cookies },
  body: '',
});
export const json = (status: number, body: unknown, cookies: string[] = [], extra: Record<string, string> = {}): HttpResponse => ({
  status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra, ...(cookies.length ? { 'Set-Cookie': cookies } : {}) },
  body: JSON.stringify(body),
});
const text = (s: unknown): string | undefined => (typeof s === 'string' && s ? s : undefined);

export function clearSessionCookie(cfg: AuthConfig): string {
  return serializeCookie(SESSION_COOKIE, '', { maxAge: 0, path: '/', httpOnly: true, secure: secure(cfg) });
}
const clearStateCookie = (cfg: AuthConfig) => serializeCookie(STATE_COOKIE, '', { maxAge: 0, path: '/auth', httpOnly: true, secure: secure(cfg) });

/** Token exchange per RFC 6749 §4.1.3 (form-encoded), normalising Opper's snake_case or camelCase fields. */
export function opperExchange(cfg: AuthConfig, fetchImpl: typeof fetch = fetch): ExchangeCode {
  return async (code) => {
    const res = await fetchImpl(`${cfg.opperUrl.replace(/\/+$/, '')}/oauth/token`, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: cfg.clientId ?? '',
        client_secret: cfg.clientSecret ?? '',
        redirect_uri: cfg.redirectUri,
      }),
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw new Error(text(data.detail) ?? text(data.error) ?? `token exchange failed (HTTP ${res.status})`);
    const apiKey = text(data.api_key) ?? text(data.apiKey);
    if (!apiKey) throw new Error('token response had no API key');
    const user = (data.user && typeof data.user === 'object' ? data.user : {}) as Record<string, unknown>;
    const out: Exchanged = { apiKey, user: {} };
    if (text(user.name)) out.user.name = text(user.name);
    if (text(user.email)) out.user.email = text(user.email);
    const projectName = text(data.project_name) ?? text(data.projectName);
    const expiresAt = text(data.expires_at) ?? text(data.expiresAt);
    if (projectName) out.projectName = projectName;
    if (expiresAt) out.expiresAt = expiresAt;
    return out;
  };
}

export function handleLogin(_req: HttpRequest, cfg: AuthConfig, random = () => randomBytes(32).toString('hex')): HttpResponse {
  if (!loginConfigured(cfg)) {
    return { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: 'Login with Opper is not configured: set OPPER_CLIENT_ID and OPPER_CLIENT_SECRET in .env.' };
  }
  const state = random();
  const params = new URLSearchParams({ client_id: cfg.clientId!, redirect_uri: cfg.redirectUri, response_type: 'code', state });
  return redirect(`${cfg.opperUrl.replace(/\/+$/, '')}/oauth/authorize?${params}`, [
    serializeCookie(STATE_COOKIE, state, { maxAge: 600, path: '/auth', httpOnly: true, secure: secure(cfg) }),
  ]);
}

export async function handleCallback(req: HttpRequest, cfg: AuthConfig, exchange: ExchangeCode, now = Date.now()): Promise<HttpResponse> {
  const fail = (why: string) => redirect(`/?auth_error=${why}`, [clearStateCookie(cfg)]);
  let url: URL;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    return fail('state');
  }
  const expected = parseCookies(header(req, 'cookie'))[STATE_COOKIE];
  const state = url.searchParams.get('state');
  if (!expected || !state || !safeEqual(expected, state)) return fail('state');
  if (url.searchParams.get('error')) return fail('denied');
  const code = url.searchParams.get('code');
  if (!code) return fail('exchange');
  let result: Exchanged;
  try {
    result = await exchange(code);
  } catch {
    return fail('exchange');
  }
  if (result.expiresAt && !(Date.parse(result.expiresAt) > now)) return fail('exchange');
  const session: SessionData = { v: 1, apiKey: result.apiKey, user: result.user, issuedAt: now };
  if (result.projectName) session.projectName = result.projectName;
  if (result.expiresAt) session.expiresAt = result.expiresAt;
  const untilExpiry = result.expiresAt ? (Date.parse(result.expiresAt) - now) / 1000 : Infinity;
  const maxAge = Math.min(SESSION_MAX_AGE_S, Number.isFinite(untilExpiry) ? untilExpiry : SESSION_MAX_AGE_S);
  return redirect('/', [
    serializeCookie(SESSION_COOKIE, sealSession(session, cfg.sessionSecret), { maxAge, path: '/', httpOnly: true, secure: secure(cfg) }),
    clearStateCookie(cfg),
  ]);
}

export function sessionFrom(req: HttpRequest, cfg: AuthConfig, now = Date.now()): SessionData | null {
  return openSession(parseCookies(header(req, 'cookie'))[SESSION_COOKIE], cfg.sessionSecret, now);
}

export function handleLogout(req: HttpRequest, cfg: AuthConfig): HttpResponse {
  if (req.method !== 'POST') return json(405, { error: 'POST only' }, [], { Allow: 'POST' });
  if (crossSite(req)) return json(403, { error: 'Cross-site request refused' });
  if (!header(req, 'content-type').toLowerCase().startsWith('application/json')) return json(415, { error: 'Expected application/json' });
  return json(200, { ok: true }, [clearSessionCookie(cfg)]);
}

/** `devProvider` is where the server's own key sends calls when nobody is signed in (undefined: no dev key). */
export function handleMe(req: HttpRequest, cfg: AuthConfig, devProvider: 'opper' | 'typesafe' | undefined, env: Record<string, string | undefined> = process.env): HttpResponse {
  const session = sessionFrom(req, cfg);
  const base = { walletUrl: WALLET_URL, loginAvailable: loginConfigured(cfg) };
  // Which decision models this key can play, and the one used when the game names none (JEV_MODEL, else jev).
  const models = (provider: 'opper' | 'typesafe') => ({
    defaultModel: env.JEV_MODEL?.trim() || DEFAULT_MODEL,
    models: provider === 'opper' ? DECISION_MODELS.map((m) => m.id) : [DEFAULT_MODEL],
  });
  if (session) {
    return json(200, { mode: 'player', user: session.user, ...(session.projectName ? { projectName: session.projectName } : {}), ...base, ...models('opper') });
  }
  return json(200, devProvider ? { mode: 'dev', devProvider, ...base, ...models(devProvider) } : { mode: 'none', ...base });
}
