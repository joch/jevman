# Login with Opper Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Visitors sign in with Login with Opper and jev calls bill their own Opper wallet; logged-out visitors watch a recorded jev game; local dev keeps the `.env` key.

**Architecture:** Framework-agnostic server handlers (`server/session.ts`, `server/auth.ts`, `server/decide.ts`) take a small request shape and return `{ status, headers, body }`; one Vite middleware (`server/plugin.ts`) routes `/auth/*`, `/api/me`, `/api/decide` to them. The player's key lives in an AES-256-GCM encrypted httpOnly cookie. The recorded demo replays the deterministic simulation from a JSON recording made by `npm run bench -- --record`.

**Tech Stack:** Node 26 `node:crypto`, Vite 8 middleware, TypeScript 7, Vitest 5. No new runtime dependencies (the token exchange is a 15-line form POST, proven in the spike).

**Spec:** `docs/superpowers/specs/2026-10-04-login-with-opper-design.md`

## Global Constraints

- Authorize: `GET {OPPER_BASE_URL}/oauth/authorize?client_id&redirect_uri&response_type=code&state`. Token: `POST {OPPER_BASE_URL}/oauth/token`, `application/x-www-form-urlencoded`, `grant_type=authorization_code, code, client_id, client_secret, redirect_uri`. Spike (2026-10-04) response fields: `api_key`, `token_type`, `user` — no project name or expiry; treat `project_name`/`projectName`, `expires_at`/`expiresAt` as optional.
- A Login-with-Opper key works with `typesafe/jev-1.13.0` on `/v3/compat/v1/systemone` (spike: HTTP 200).
- Cookies: `jevman_session` (httpOnly, SameSite=Lax, Path=/, Max-Age ≤ 30 days, Secure iff redirect URI is https); `jevman_oauth_state` (httpOnly, SameSite=Lax, Path=/auth, Max-Age 600).
- Env: `OPPER_CLIENT_ID`, `OPPER_CLIENT_SECRET`, `OPPER_REDIRECT_URI` (default `http://localhost:5173/auth/callback`), `SESSION_SECRET` (≥ 32 chars; dev fallback random + warning), `OPPER_API_KEY` (dev key, Vite only), `OPPER_BASE_URL` (default `https://api.opper.ai`). Wallet URL `https://platform.opper.ai/wallet`.
- The API key (player or dev) never appears in a URL, log line, response body, page JS or test output.
- `/api/decide` and `/auth/logout` require `Content-Type: application/json`.
- Never read/print `.env`. `npm run bench`/`npm run smoke` make paid calls — only the controller runs them.

## Review Focus

1. A tampered, truncated, wrong-secret or expired `jevman_session` cookie must read as signed out, never throw or 500.
2. OAuth callback with missing/mismatched `state`, a user-denied `error=` callback, or a failing token exchange must land on `/?auth_error=…`, never set a session.
3. A player key that Opper rejects mid-game (401) must clear the cookie and flip the UI to signed-out while the game keeps running on fallbacks.
4. The recorded demo must replay identically (determinism guard) — any sim change that desyncs it fails a test.
5. With no session and no dev key, `/api/decide` answers 401 `signedOut` (not 500), and the demo/sign-in UI appears — the deployed site never silently uses a server key.

---

### Task 1: Encrypted session cookie

**Files:** Create `server/session.ts`; Test `tests/session.test.ts`

**Produces:** `interface SessionData { v: 1; apiKey: string; user: { name?: string; email?: string }; projectName?: string; expiresAt?: string; issuedAt: number }`, `SESSION_MAX_AGE_S = 30*24*3600`, `sealSession(data, secret): string`, `openSession(sealed: string | undefined, secret, now = Date.now()): SessionData | null`, `safeEqual(a, b): boolean`, `parseCookies(header?: string): Record<string, string>`, `interface CookieOptions { maxAge?: number; path?: string; httpOnly?: boolean; secure?: boolean; sameSite?: 'Lax' | 'Strict' }`, `serializeCookie(name, value, opts?): string`.

- [ ] **Step 1: Failing tests** — `tests/session.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { openSession, parseCookies, safeEqual, sealSession, serializeCookie, SESSION_MAX_AGE_S, type SessionData } from '../server/session';

const SECRET = 'a'.repeat(64);
const data = (over: Partial<SessionData> = {}): SessionData => ({ v: 1, apiKey: 'op-test-key', user: { name: 'Ada', email: 'ada@example.com' }, issuedAt: 1_000, ...over });

describe('session cookie', () => {
  it('round-trips sealed data and hides the key', () => {
    const sealed = sealSession(data(), SECRET);
    expect(sealed).not.toContain('op-test-key');
    expect(openSession(sealed, SECRET, 2_000)).toEqual(data());
  });
  it('produces a different ciphertext each time', () => {
    expect(sealSession(data(), SECRET)).not.toBe(sealSession(data(), SECRET));
  });
  it('rejects tampering, the wrong secret, malformed input and missing values', () => {
    const sealed = sealSession(data(), SECRET);
    const [iv, ct, tag] = sealed.split('.');
    const flipped = ct.slice(0, -2) + (ct.endsWith('A') ? 'B' : 'A') + ct.slice(-1);
    expect(openSession(`${iv}.${flipped}.${tag}`, SECRET, 2_000)).toBeNull();
    expect(openSession(sealed, 'b'.repeat(64), 2_000)).toBeNull();
    expect(openSession('garbage', SECRET)).toBeNull();
    expect(openSession('a.b.c', SECRET)).toBeNull();
    expect(openSession(undefined, SECRET)).toBeNull();
    expect(openSession(sealSession(data({ apiKey: '' }), SECRET), SECRET, 2_000)).toBeNull();
  });
  it('expires at expiresAt and after the 30-day cap', () => {
    const exp = sealSession(data({ expiresAt: new Date(5_000).toISOString() }), SECRET);
    expect(openSession(exp, SECRET, 4_999)).not.toBeNull();
    expect(openSession(exp, SECRET, 5_000)).toBeNull();
    const old = sealSession(data({ issuedAt: 0 }), SECRET);
    expect(openSession(old, SECRET, SESSION_MAX_AGE_S * 1000 + 1)).toBeNull();
  });
  it('compares strings in constant time', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'ab')).toBe(false);
  });
  it('parses and serializes cookies', () => {
    expect(parseCookies('a=1; jevman_session=x%3Dy; bad')).toEqual({ a: '1', jevman_session: 'x=y' });
    expect(parseCookies(undefined)).toEqual({});
    expect(serializeCookie('s', 'v=1', { maxAge: 60.7, path: '/', httpOnly: true, secure: true })).toBe('s=v%3D1; Max-Age=60; Path=/; HttpOnly; Secure; SameSite=Lax');
    expect(serializeCookie('s', '', { maxAge: 0, path: '/auth' })).toBe('s=; Max-Age=0; Path=/auth; SameSite=Lax');
  });
});
```

- [ ] **Step 2:** `npx vitest run tests/session.test.ts` → FAIL (module missing).
- [ ] **Step 3: Implement** `server/session.ts`:

```ts
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';

export interface SessionData {
  v: 1;
  apiKey: string;
  user: { name?: string; email?: string };
  projectName?: string;
  expiresAt?: string;
  issuedAt: number;
}

export const SESSION_MAX_AGE_S = 30 * 24 * 3600;

const keyFor = (secret: string): Buffer => Buffer.from(hkdfSync('sha256', secret, 'jevman', 'jevman-session-v1', 32));

/** AES-256-GCM, encoded as base64url `iv.ciphertext.tag`. */
export function sealSession(data: SessionData, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyFor(secret), iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()]);
  return [iv, ct, cipher.getAuthTag()].map((b) => b.toString('base64url')).join('.');
}

/** The session, or null for anything missing, tampered, malformed, sealed with another secret, or expired. */
export function openSession(sealed: string | undefined, secret: string, now = Date.now()): SessionData | null {
  if (!sealed) return null;
  const parts = sealed.split('.');
  if (parts.length !== 3) return null;
  try {
    const [iv, ct, tag] = parts.map((p) => Buffer.from(p, 'base64url'));
    if (iv.length !== 12 || tag.length !== 16) return null;
    const decipher = createDecipheriv('aes-256-gcm', keyFor(secret), iv);
    decipher.setAuthTag(tag);
    const data = JSON.parse(Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8')) as SessionData;
    if (data?.v !== 1 || typeof data.apiKey !== 'string' || !data.apiKey || typeof data.issuedAt !== 'number') return null;
    if (now - data.issuedAt > SESSION_MAX_AGE_S * 1000) return null;
    if (data.expiresAt && !(Date.parse(data.expiresAt) > now)) return null;
    return data;
  } catch {
    return null;
  }
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    const name = part.slice(0, i).trim();
    try {
      out[name] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      // ignore undecodable values
    }
  }
  return out;
}

export interface CookieOptions {
  maxAge?: number;
  path?: string;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Lax' | 'Strict';
}

export function serializeCookie(name: string, value: string, o: CookieOptions = {}): string {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (o.maxAge !== undefined) parts.push(`Max-Age=${Math.max(0, Math.floor(o.maxAge))}`);
  if (o.path) parts.push(`Path=${o.path}`);
  if (o.httpOnly) parts.push('HttpOnly');
  if (o.secure) parts.push('Secure');
  parts.push(`SameSite=${o.sameSite ?? 'Lax'}`);
  return parts.join('; ');
}
```

- [ ] **Step 4:** `npx vitest run tests/session.test.ts && npm run typecheck` → PASS.
- [ ] **Step 5:** `git add server/session.ts tests/session.test.ts && git commit -m "Add encrypted session cookie helpers"`

---

### Task 2: Auth handlers

**Files:** Create `server/auth.ts`; Test `tests/auth.test.ts`

**Consumes:** Task 1. **Produces:** `WALLET_URL`, `SESSION_COOKIE = 'jevman_session'`, `STATE_COOKIE = 'jevman_oauth_state'`, `interface AuthConfig { clientId?: string; clientSecret?: string; redirectUri: string; opperUrl: string; sessionSecret: string }`, `interface HttpRequest { method: string; url: string; headers: Record<string, string | string[] | undefined> }`, `interface HttpResponse { status: number; headers: Record<string, string | string[]>; body: string }`, `interface Exchanged { apiKey: string; user: { name?: string; email?: string }; projectName?: string; expiresAt?: string }`, `type ExchangeCode = (code: string) => Promise<Exchanged>`, `loginConfigured(cfg)`, `opperExchange(cfg, fetchImpl = fetch): ExchangeCode`, `handleLogin(req, cfg, random?)`, `handleCallback(req, cfg, exchange, now?)`, `handleLogout(req, cfg)`, `sessionFrom(req, cfg, now?)`, `clearSessionCookie(cfg)`, `handleMe(req, cfg, hasDevKey: boolean)`.

- [ ] **Step 1: Failing tests** — `tests/auth.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { handleCallback, handleLogin, handleLogout, handleMe, opperExchange, sessionFrom, SESSION_COOKIE, STATE_COOKIE, type AuthConfig, type HttpRequest } from '../server/auth';
import { openSession, sealSession } from '../server/session';

const cfg: AuthConfig = { clientId: 'opper_app_x', clientSecret: 'shh', redirectUri: 'http://localhost:5173/auth/callback', opperUrl: 'https://api.opper.ai', sessionSecret: 's'.repeat(64) };
const req = (url: string, headers: HttpRequest['headers'] = {}, method = 'GET'): HttpRequest => ({ method, url, headers });
const setCookies = (r: { headers: Record<string, string | string[]> }) => ([] as string[]).concat(r.headers['Set-Cookie'] ?? []);
const cookieValue = (r: { headers: Record<string, string | string[]> }, name: string) => {
  const c = setCookies(r).find((s) => s.startsWith(`${name}=`))!;
  return decodeURIComponent(c.slice(name.length + 1).split(';')[0]);
};

describe('handleLogin', () => {
  it('redirects to Opper with a state cookie', () => {
    const r = handleLogin(req('/auth/login'), cfg, () => 'st4te');
    expect(r.status).toBe(302);
    const loc = new URL(r.headers.Location as string);
    expect(loc.origin + loc.pathname).toBe('https://api.opper.ai/oauth/authorize');
    expect(Object.fromEntries(loc.searchParams)).toEqual({ client_id: 'opper_app_x', redirect_uri: cfg.redirectUri, response_type: 'code', state: 'st4te' });
    expect(setCookies(r)[0]).toBe(`${STATE_COOKIE}=st4te; Max-Age=600; Path=/auth; HttpOnly; SameSite=Lax`);
  });
  it('explains missing configuration', () => {
    const r = handleLogin(req('/auth/login'), { ...cfg, clientSecret: undefined });
    expect(r.status).toBe(503);
    expect(r.body).toMatch(/OPPER_CLIENT_ID.*OPPER_CLIENT_SECRET/);
  });
});

describe('handleCallback', () => {
  const withState = (url: string) => req(url, { cookie: `${STATE_COOKIE}=st4te` });
  it('exchanges the code, sets a sealed session and clears the state', async () => {
    const exchange = vi.fn(async () => ({ apiKey: 'op-player', user: { name: 'Ada' } }));
    const r = await handleCallback(withState('/auth/callback?code=c0de&state=st4te'), cfg, exchange, 10_000);
    expect(exchange).toHaveBeenCalledWith('c0de');
    expect(r.status).toBe(302);
    expect(r.headers.Location).toBe('/');
    expect(r.body).not.toContain('op-player');
    const session = openSession(cookieValue(r, SESSION_COOKIE), cfg.sessionSecret, 10_001)!;
    expect(session).toMatchObject({ apiKey: 'op-player', user: { name: 'Ada' }, issuedAt: 10_000 });
    expect(setCookies(r).find((c) => c.startsWith(SESSION_COOKIE))).toMatch(/Max-Age=2592000; Path=\/; HttpOnly; SameSite=Lax/);
    expect(setCookies(r).find((c) => c.startsWith(STATE_COOKIE))).toMatch(/Max-Age=0/);
  });
  it('caps the cookie lifetime at the key expiry', async () => {
    const exchange = async () => ({ apiKey: 'op-player', user: {}, expiresAt: new Date(10_000 + 3_600_000).toISOString() });
    const r = await handleCallback(withState('/auth/callback?code=c&state=st4te'), cfg, exchange, 10_000);
    expect(setCookies(r).find((c) => c.startsWith(SESSION_COOKIE))).toMatch(/Max-Age=3600;/);
  });
  it.each([
    ['/auth/callback?code=c&state=wrong', 'state'],
    ['/auth/callback?code=c', 'state'],
    ['/auth/callback?error=access_denied&state=st4te', 'denied'],
    ['/auth/callback?state=st4te', 'exchange'],
  ])('rejects %s with auth_error=%s and no session', async (url, why) => {
    const exchange = vi.fn(async () => ({ apiKey: 'op-player', user: {} }));
    const r = await handleCallback(withState(url), cfg, exchange);
    expect(r.headers.Location).toBe(`/?auth_error=${why}`);
    expect(setCookies(r).some((c) => c.startsWith(`${SESSION_COOKIE}=`) && !c.includes('Max-Age=0'))).toBe(false);
  });
  it('reports a failing token exchange', async () => {
    const r = await handleCallback(withState('/auth/callback?code=c&state=st4te'), cfg, async () => {
      throw new Error('nope');
    });
    expect(r.headers.Location).toBe('/?auth_error=exchange');
  });
});

describe('opperExchange', () => {
  it('posts the form and normalises the response', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ api_key: 'op-k', token_type: 'bearer', user: { name: 'Ada', email: 'a@x', id: 7 } }), { status: 200 }));
    const out = await opperExchange(cfg, fetchMock)('c0de');
    expect(out).toEqual({ apiKey: 'op-k', user: { name: 'Ada', email: 'a@x' } });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.opper.ai/oauth/token');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(Object.fromEntries(new URLSearchParams(String(init.body)))).toEqual({ grant_type: 'authorization_code', code: 'c0de', client_id: 'opper_app_x', client_secret: 'shh', redirect_uri: cfg.redirectUri });
  });
  it('throws on a failed exchange or a response without a key', async () => {
    await expect(opperExchange(cfg, async () => new Response('{"detail":"bad code"}', { status: 400 }))('c')).rejects.toThrow('bad code');
    await expect(opperExchange(cfg, async () => new Response('{}', { status: 200 }))('c')).rejects.toThrow(/no api key/i);
  });
});

describe('session lookup, logout and /api/me', () => {
  const sealed = sealSession({ v: 1, apiKey: 'op-player', user: { name: 'Ada' }, projectName: 'jevman', issuedAt: Date.now() }, cfg.sessionSecret);
  const signedIn = (url: string, method = 'GET', extra: Record<string, string> = {}) => req(url, { cookie: `${SESSION_COOKIE}=${encodeURIComponent(sealed)}`, ...extra }, method);

  it('reads the session from the cookie', () => {
    expect(sessionFrom(signedIn('/'), cfg)?.apiKey).toBe('op-player');
    expect(sessionFrom(req('/', { cookie: `${SESSION_COOKIE}=tampered` }), cfg)).toBeNull();
  });
  it('logs out only with a JSON POST', () => {
    expect(handleLogout(signedIn('/auth/logout', 'POST'), cfg).status).toBe(415);
    const r = handleLogout(signedIn('/auth/logout', 'POST', { 'content-type': 'application/json' }), cfg);
    expect(r.status).toBe(200);
    expect(setCookies(r)[0]).toMatch(new RegExp(`^${SESSION_COOKIE}=; Max-Age=0; Path=/`));
    expect(handleLogout(signedIn('/auth/logout'), cfg).status).toBe(405);
  });
  it('describes the account without the key', () => {
    const player = JSON.parse(handleMe(signedIn('/api/me'), cfg, true).body);
    expect(player).toEqual({ mode: 'player', user: { name: 'Ada' }, projectName: 'jevman', walletUrl: 'https://platform.opper.ai/wallet', loginAvailable: true });
    expect(JSON.parse(handleMe(req('/api/me'), cfg, true).body).mode).toBe('dev');
    expect(JSON.parse(handleMe(req('/api/me'), { ...cfg, clientId: undefined }, false).body)).toMatchObject({ mode: 'none', loginAvailable: false });
    expect(handleMe(signedIn('/api/me'), cfg, true).body).not.toContain('op-player');
  });
});
```

- [ ] **Step 2:** `npx vitest run tests/auth.test.ts` → FAIL.
- [ ] **Step 3: Implement** `server/auth.ts`:

```ts
import { randomBytes } from 'node:crypto';
import { openSession, parseCookies, safeEqual, sealSession, serializeCookie, SESSION_MAX_AGE_S, type SessionData } from './session';

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
const header = (req: HttpRequest, name: string): string => {
  const v = req.headers[name];
  return Array.isArray(v) ? v.join('; ') : (v ?? '');
};
const redirect = (location: string, cookies: string[] = []): HttpResponse => ({
  status: 302,
  headers: { Location: location, 'Set-Cookie': cookies },
  body: '',
});
const json = (status: number, body: unknown, cookies: string[] = []): HttpResponse => ({
  status,
  headers: { 'Content-Type': 'application/json', ...(cookies.length ? { 'Set-Cookie': cookies } : {}) },
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
  const url = new URL(req.url, 'http://localhost');
  const fail = (why: string) => redirect(`/?auth_error=${why}`, [clearStateCookie(cfg)]);
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
  if (req.method !== 'POST') return json(405, { error: 'POST only' });
  if (!header(req, 'content-type').toLowerCase().startsWith('application/json')) return json(415, { error: 'Expected application/json' });
  return json(200, { ok: true }, [clearSessionCookie(cfg)]);
}

export function handleMe(req: HttpRequest, cfg: AuthConfig, hasDevKey: boolean): HttpResponse {
  const session = sessionFrom(req, cfg);
  const base = { walletUrl: WALLET_URL, loginAvailable: loginConfigured(cfg) };
  if (session) {
    return json(200, { mode: 'player', user: session.user, ...(session.projectName ? { projectName: session.projectName } : {}), ...base });
  }
  return json(200, { mode: hasDevKey ? 'dev' : 'none', ...base });
}
```

Note the `/api/me` test expects key order `mode, user, projectName, walletUrl, loginAvailable` — `toEqual` ignores order, fine.

- [ ] **Step 4:** `npx vitest run tests/auth.test.ts && npm run typecheck` → PASS.
- [ ] **Step 5:** `git add server/auth.ts tests/auth.test.ts && git commit -m "Add Login with Opper auth handlers"`

---

### Task 3: Player keys in `/api/decide`, routing plugin

**Files:** Modify `server/decide.ts` (remove `jevPlugin`, add `keyMode` mapping and `resolveKey`); Create `server/plugin.ts`; Modify `vite.config.ts`, `.env.example`; Move middleware tests from `tests/decide.test.ts` to new `tests/plugin.test.ts`.

**Consumes:** Tasks 1–2. **Produces:** `DecideDeps.keyMode?: 'player' | 'dev'`; `resolveKey(session: SessionData | null, devKey?: string): { apiKey: string; mode: 'player' | 'dev' } | null`; `jevPlugin(env: Record<string, string>): Plugin` (now in `server/plugin.ts`); `authConfigFromEnv(env, warn): AuthConfig`.

- [ ] **Step 1: Failing tests.** Append to `tests/decide.test.ts` (and change its import line to `import { handleDecide, JEV_MODEL, resolveKey, type DecideDeps } from '../server/decide';`, deleting the whole `describe('jevPlugin middleware', …)` block and the now-unused `EventEmitter` import):

```ts
describe('player keys', () => {
  const upstream = (status: number) => vi.fn<typeof fetch>(async () => new Response('{"error":"x"}', { status }));
  it.each([
    [401, 401, { error: 'Your Opper sign-in has expired — sign in again', signedOut: true, clearSession: true }],
    [402, 402, { error: 'Your Opper wallet is empty — top up to keep playing', walletUrl: 'https://platform.opper.ai/wallet' }],
    [403, 403, { error: 'jev is not enabled for your Opper account' }],
  ])('maps upstream %i to %i for a player key', async (up, status, bodyOut) => {
    const res = await handleDecide(body, deps(upstream(up), { keyMode: 'player' }));
    expect(res).toEqual({ status, body: bodyOut });
  });
  it('keeps the 502 mapping for the dev key', async () => {
    expect((await handleDecide(body, deps(upstream(401), { keyMode: 'dev' }))).status).toBe(502);
  });
  it('labels log lines with the key mode', async () => {
    const log = vi.fn();
    await handleDecide(body, deps(ok(), { keyMode: 'player', log }));
    expect(log.mock.calls[0][0]).toMatch(/^\[jev player\] /);
  });
});

describe('resolveKey', () => {
  const session = { v: 1 as const, apiKey: 'op-player', user: {}, issuedAt: 0 };
  it('prefers the signed-in player, then the dev key, else none', () => {
    expect(resolveKey(session, 'op-dev')).toEqual({ apiKey: 'op-player', mode: 'player' });
    expect(resolveKey(null, 'op-dev')).toEqual({ apiKey: 'op-dev', mode: 'dev' });
    expect(resolveKey(null, '')).toBeNull();
    expect(resolveKey(null, undefined)).toBeNull();
  });
});
```

Create `tests/plugin.test.ts`:

```ts
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SESSION_COOKIE } from '../server/auth';
import { jevPlugin } from '../server/plugin';
import { sealSession } from '../server/session';

const SECRET = 's'.repeat(64);
const decideBody = { state: { maze: ['#'] }, questions: { blinky: { type: 'choice', instructions: 'chase', criteria: { left: 'a', up: 'b' } } } };
type Req = EventEmitter & { method: string; url: string; headers: Record<string, string> };

function mount(env: Record<string, string>, logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }) {
  let handler!: (req: Req, res: unknown, next: () => void) => void;
  const plugin = jevPlugin({ SESSION_SECRET: SECRET, OPPER_BASE_URL: 'https://api.opper.ai', ...env });
  (plugin.configureServer as (s: unknown) => void)({ config: { logger }, middlewares: { use: (h: typeof handler) => (handler = h) } });
  return { handler, logger };
}

function fakeRes() {
  const headers: Record<string, string | string[]> = {};
  const res = {
    statusCode: 200,
    headersSent: false,
    setHeader: (k: string, v: string | string[]) => (headers[k] = v),
    end: vi.fn((_chunk?: string) => (res.headersSent = true)),
    headers,
  };
  return res;
}

function call(handler: ReturnType<typeof mount>['handler'], method: string, url: string, headers: Record<string, string> = {}, payload?: unknown) {
  const res = fakeRes();
  const next = vi.fn();
  const req = Object.assign(new EventEmitter(), { method, url, headers }) as Req;
  handler(req, res, next);
  if (payload !== undefined) {
    req.emit('data', JSON.stringify(payload));
    req.emit('end');
  }
  return { res, next };
}

afterEach(() => vi.unstubAllGlobals());

describe('jevPlugin routing', () => {
  it('passes other paths through', () => {
    const { handler } = mount({});
    expect(call(handler, 'GET', '/src/main.ts').next).toHaveBeenCalled();
  });

  it('redirects /auth/login to Opper when configured', () => {
    const { handler } = mount({ OPPER_CLIENT_ID: 'opper_app_x', OPPER_CLIENT_SECRET: 'shh' });
    const { res } = call(handler, 'GET', '/auth/login');
    expect(res.statusCode).toBe(302);
    expect(String(res.headers.Location)).toMatch(/^https:\/\/api\.opper\.ai\/oauth\/authorize\?/);
  });

  it('answers /api/me without a session in dev mode', () => {
    const { handler } = mount({ OPPER_API_KEY: 'op-dev' });
    const { res } = call(handler, 'GET', '/api/me');
    expect(JSON.parse(res.end.mock.calls[0][0] as string)).toMatchObject({ mode: 'dev', loginAvailable: false });
  });

  it('asks the player to sign in when there is no session and no dev key', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const { handler } = mount({});
    const { res } = call(handler, 'POST', '/api/decide', { 'content-type': 'application/json' }, decideBody);
    await vi.waitFor(() => expect(res.end).toHaveBeenCalled());
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.end.mock.calls[0][0] as string)).toEqual({ error: 'Sign in with Opper to let jev play', signedOut: true });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('uses the player key from the session cookie and clears it when Opper rejects it', async () => {
    const auth: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: RequestInit) => {
      auth.push((init.headers as Record<string, string>).Authorization);
      return new Response('{"error":"invalid"}', { status: 401 });
    }));
    const { handler, logger } = mount({ OPPER_API_KEY: 'op-dev' });
    const cookie = `${SESSION_COOKIE}=${encodeURIComponent(sealSession({ v: 1, apiKey: 'op-player', user: {}, issuedAt: Date.now() }, SECRET))}`;
    const { res } = call(handler, 'POST', '/api/decide', { 'content-type': 'application/json', cookie }, decideBody);
    await vi.waitFor(() => expect(res.end).toHaveBeenCalled());
    expect(auth).toEqual(['Bearer op-player']);
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.end.mock.calls[0][0] as string)).toEqual({ error: 'Your Opper sign-in has expired — sign in again', signedOut: true });
    expect(String(res.headers['Set-Cookie'])).toMatch(new RegExp(`^${SESSION_COOKIE}=; Max-Age=0`));
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain('op-player');
  });

  it('answers 500 and ends the response when handling throws, instead of hanging', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('boom');
    });
    const logger = { info: vi.fn(() => { throw new Error('logger exploded with op-dev'); }), warn: vi.fn(), error: vi.fn() };
    const { handler } = mount({ OPPER_API_KEY: 'op-dev' }, logger);
    const { res } = call(handler, 'POST', '/api/decide', { 'content-type': 'application/json' }, decideBody);
    await vi.waitFor(() => expect(res.end).toHaveBeenCalled());
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.end.mock.calls[0][0] as string)).toEqual({ error: 'internal error in /api/decide' });
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('op-dev');
  });

  it('answers 405 to non-POST /api/decide', () => {
    const { handler } = mount({ OPPER_API_KEY: 'op-dev' });
    expect(call(handler, 'GET', '/api/decide').res.statusCode).toBe(405);
  });

  it.each([['text/plain'], [undefined]])('answers 415 without calling jev for Content-Type %s (CSRF guard)', (contentType) => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const { handler } = mount({ OPPER_API_KEY: 'op-dev' });
    const { res } = call(handler, 'POST', '/api/decide', contentType ? { 'content-type': contentType } : {});
    expect(res.statusCode).toBe(415);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('warns once and uses a random secret when SESSION_SECRET is missing or short', () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    mount({ SESSION_SECRET: 'short' }, logger);
    expect(logger.warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('SESSION_SECRET'))).toHaveLength(1);
  });
});
```

- [ ] **Step 2:** `npx vitest run tests/decide.test.ts tests/plugin.test.ts` → FAIL.
- [ ] **Step 3: Implement.**

In `server/decide.ts`: delete `jevPlugin` and the `import type { Plugin } from 'vite'` line; add `import { WALLET_URL } from './auth';` and `import type { SessionData } from './session';`; add `keyMode?: 'player' | 'dev';` to `DecideDeps`; change the log prefix so every `log(\`[jev] …\`)` becomes `log(\`${tag} …\`)` with `const tag = deps.keyMode ? \`[jev ${deps.keyMode}]\` : '[jev]';` defined after `log`; in the `!res.ok` branch, before `return { status: 502, … }`, insert:

```ts
      if (deps.keyMode === 'player') {
        if (res.status === 401) return { status: 401, body: { error: 'Your Opper sign-in has expired — sign in again', signedOut: true, clearSession: true } };
        if (res.status === 402) return { status: 402, body: { error: 'Your Opper wallet is empty — top up to keep playing', walletUrl: WALLET_URL } };
        if (res.status === 403) return { status: 403, body: { error: 'jev is not enabled for your Opper account' } };
      }
```

and append:

```ts
/** The key a decide call uses: the signed-in player's, else the local dev key, else none. */
export function resolveKey(session: SessionData | null, devKey?: string): { apiKey: string; mode: 'player' | 'dev' } | null {
  if (session) return { apiKey: session.apiKey, mode: 'player' };
  if (devKey) return { apiKey: devKey, mode: 'dev' };
  return null;
}
```

Create `server/plugin.ts`:

```ts
import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import { clearSessionCookie, handleCallback, handleLogin, handleLogout, handleMe, opperExchange, sessionFrom, type AuthConfig, type HttpRequest, type HttpResponse } from './auth';
import { handleDecide, resolveKey } from './decide';

export function authConfigFromEnv(env: Record<string, string>, warn: (msg: string) => void): AuthConfig {
  let sessionSecret = env.SESSION_SECRET ?? '';
  if (sessionSecret.length < 32) {
    warn('[auth] SESSION_SECRET is missing or shorter than 32 characters — using a random one; sign-ins reset on restart');
    sessionSecret = randomBytes(32).toString('hex');
  }
  return {
    clientId: env.OPPER_CLIENT_ID || undefined,
    clientSecret: env.OPPER_CLIENT_SECRET || undefined,
    redirectUri: env.OPPER_REDIRECT_URI || 'http://localhost:5173/auth/callback',
    opperUrl: env.OPPER_BASE_URL || 'https://api.opper.ai',
    sessionSecret,
  };
}

const toHttp = (req: IncomingMessage): HttpRequest => ({ method: req.method ?? 'GET', url: req.url ?? '/', headers: req.headers });

function send(res: ServerResponse, r: HttpResponse): void {
  res.statusCode = r.status;
  for (const [k, v] of Object.entries(r.headers)) if (!(Array.isArray(v) && v.length === 0)) res.setHeader(k, v);
  res.end(r.body);
}

const sendJson = (res: ServerResponse, status: number, body: unknown, setCookie?: string) =>
  send(res, { status, headers: { 'Content-Type': 'application/json', ...(setCookie ? { 'Set-Cookie': setCookie } : {}) }, body: JSON.stringify(body) });

/** Dev-server routes: Login with Opper, the account endpoint and the jev proxy. The dev key never leaves the server. */
export function jevPlugin(env: Record<string, string>): Plugin {
  return {
    name: 'jev-decide',
    configureServer(server) {
      const logger = server.config.logger;
      const quiet = Boolean(process.env.VITEST);
      const cfg = authConfigFromEnv(env, (m) => logger.warn(m));
      const devKey = env.OPPER_API_KEY || undefined;
      if (!devKey && !cfg.clientId && !quiet) logger.warn('[jev] neither OPPER_API_KEY nor OPPER_CLIENT_ID/SECRET is set — jev cannot play');
      const exchange = opperExchange(cfg);

      server.middlewares.use((req: IncomingMessage, res: ServerResponse, next: () => void) => {
        const path = (req.url ?? '').split('?')[0];
        const http = toHttp(req);
        if (path === '/auth/login') return send(res, handleLogin(http, cfg));
        if (path === '/auth/callback') {
          void handleCallback(http, cfg, exchange).then((r) => send(res, r), () => send(res, { status: 302, headers: { Location: '/?auth_error=exchange' }, body: '' }));
          return;
        }
        if (path === '/auth/logout') return send(res, handleLogout(http, cfg));
        if (path === '/api/me') return send(res, handleMe(http, cfg, Boolean(devKey)));
        if (path !== '/api/decide') return next();

        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end();
          return;
        }
        // A cross-site form can send text/plain without a CORS preflight; require JSON so only our own page can spend credit.
        if (!String(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
          return sendJson(res, 415, { error: 'Expected application/json' });
        }
        const key = resolveKey(sessionFrom(http, cfg), devKey);
        const redact = (s: string) => [key?.apiKey, devKey].reduce((acc, k) => (k ? acc.split(k).join('[redacted]') : acc), s);
        let raw = '';
        const fail = (error: string): void => {
          if (!res.headersSent) sendJson(res, 500, { error });
          else res.end();
        };
        req.on('error', (err) => fail(`request failed: ${redact(err.message)}`));
        req.on('data', (chunk) => (raw += chunk));
        req.on('end', async () => {
          try {
            if (!key) return sendJson(res, 401, { error: 'Sign in with Opper to let jev play', signedOut: true });
            let input: unknown = null;
            try {
              input = JSON.parse(raw);
            } catch {
              // handled as a 400 by handleDecide
            }
            const result = await handleDecide(input, {
              apiKey: key.apiKey,
              keyMode: key.mode,
              baseUrl: cfg.opperUrl,
              fetch,
              now: () => performance.now(),
              log: (line) => logger.info(line, { timestamp: true }),
            });
            const { clearSession, ...body } = result.body as Record<string, unknown>;
            sendJson(res, result.status, body, clearSession ? clearSessionCookie(cfg) : undefined);
          } catch (err) {
            logger.error(`[jev] middleware failure: ${redact((err as Error)?.message ?? String(err))}`);
            fail('internal error in /api/decide');
          }
        });
      });
    },
  };
}
```

`vite.config.ts`:

```ts
/// <reference types="vitest/config" />
import { defineConfig, loadEnv } from 'vite';
import { jevPlugin } from './server/plugin.ts';

export default defineConfig(({ mode }) => ({
  plugins: [jevPlugin(loadEnv(mode, process.cwd(), ['OPPER_', 'SESSION_']))],
  test: { include: ['tests/**/*.test.ts'] },
}));
```

`.env.example`:

```
# Option A — play with your own Opper key (local dev only)
OPPER_API_KEY=
OPPER_BASE_URL=https://api.opper.ai

# Option B — Login with Opper (players pay with their own Opper wallet)
OPPER_CLIENT_ID=
OPPER_CLIENT_SECRET=
OPPER_REDIRECT_URI=http://localhost:5173/auth/callback
# 32+ random characters, e.g. `openssl rand -hex 32`
SESSION_SECRET=
```

Check `scripts/bench.ts` / `scripts/smoke.ts` still import `handleDecide` from `../server/decide` (unchanged).

- [ ] **Step 4:** `npm test && npm run typecheck` → PASS, output pristine (the SESSION_SECRET warning test asserts one warning; other tests pass a valid secret).
- [ ] **Step 5:** `git add -A server tests vite.config.ts .env.example && git commit -m "Route Login with Opper and player keys through the dev server"`

---

### Task 4: Account bar and auth-aware transport (live game)

**Files:** Create `src/auth.ts`; Modify `src/transport.ts`, `src/main.ts`, `index.html`, `src/style.css`; Test `tests/transport.test.ts` (extend).

**Produces:** `src/auth.ts`: `interface Me { mode: 'player' | 'dev' | 'none'; user?: { name?: string; email?: string }; projectName?: string; walletUrl: string; loginAvailable: boolean }`, `fetchMe(): Promise<Me>`, `signIn()`, `signOut(): Promise<void>`, `takeAuthError(): string | null`, `renderAccount(root: HTMLElement, view: AccountView): void` where `type AccountView = { kind: 'player' | 'dev' | 'demo' | 'signed-out'; me: Me }`. `src/transport.ts`: `interface TransportHooks { onSignedOut?: () => void; onWalletEmpty?: (url: string) => void }`, `createHttpTransport(hooks?): Transport`, `httpTransport` (= `createHttpTransport()`).

- [ ] **Step 1: Failing transport tests** — append to `tests/transport.test.ts`:

```ts
describe('createHttpTransport hooks', () => {
  it('reports a signed-out player and an empty wallet', async () => {
    const onSignedOut = vi.fn();
    const onWalletEmpty = vi.fn();
    const t = createHttpTransport({ onSignedOut, onWalletEmpty });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'expired', signedOut: true }), { status: 401 })));
    await expect(t(request)).rejects.toThrow('expired');
    expect(onSignedOut).toHaveBeenCalledOnce();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'empty', walletUrl: 'https://platform.opper.ai/wallet' }), { status: 402 })));
    await expect(t(request)).rejects.toThrow('empty');
    expect(onWalletEmpty).toHaveBeenCalledWith('https://platform.opper.ai/wallet');
    vi.unstubAllGlobals();
  });
});
```

(Use the file's existing request fixture name; if it differs from `request`, use that. Import `createHttpTransport` alongside `httpTransport`.)

- [ ] **Step 2:** `npx vitest run tests/transport.test.ts` → FAIL.
- [ ] **Step 3: Implement.**

`src/transport.ts` — wrap the existing function body in a factory; inside the `!res.ok` branch, before throwing, add:

```ts
    if ((json as { signedOut?: boolean }).signedOut) hooks.onSignedOut?.();
    if (res.status === 402 && typeof (json as { walletUrl?: unknown }).walletUrl === 'string') hooks.onWalletEmpty?.((json as { walletUrl: string }).walletUrl);
```

and end the file with `export const httpTransport: Transport = createHttpTransport();`.

`src/auth.ts`:

```ts
export interface Me {
  mode: 'player' | 'dev' | 'none';
  user?: { name?: string; email?: string };
  projectName?: string;
  walletUrl: string;
  loginAvailable: boolean;
}

export type AccountView = { kind: 'player' | 'dev' | 'demo' | 'signed-out'; me: Me };

const FALLBACK: Me = { mode: 'none', walletUrl: 'https://platform.opper.ai/wallet', loginAvailable: false };

export async function fetchMe(): Promise<Me> {
  try {
    const res = await fetch('/api/me');
    if (res.ok) return (await res.json()) as Me;
  } catch {
    // offline or no server: behave as signed out
  }
  return FALLBACK;
}

export function signIn(): void {
  window.location.href = '/auth/login';
}

export async function signOut(): Promise<void> {
  await fetch('/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).catch(() => {});
  window.location.reload();
}

const AUTH_ERRORS: Record<string, string> = {
  state: 'Sign-in could not be verified (it may have timed out). Please try again.',
  denied: 'Sign-in was cancelled.',
  exchange: 'Opper sign-in failed. Please try again.',
};

/** Reads and removes `?auth_error=` from the address bar. */
export function takeAuthError(): string | null {
  const url = new URL(window.location.href);
  const code = url.searchParams.get('auth_error');
  if (!code) return null;
  url.searchParams.delete('auth_error');
  history.replaceState(null, '', url.pathname + url.search + url.hash);
  return AUTH_ERRORS[code] ?? 'Sign-in failed. Please try again.';
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, cls?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (text) e.textContent = text;
  if (cls) e.className = cls;
  return e;
}

function signInButton(me: Me): HTMLButtonElement {
  const b = el('button', 'Sign in with Opper', 'signin');
  b.disabled = !me.loginAvailable;
  if (!me.loginAvailable) b.title = 'Login with Opper is not configured on this server';
  b.addEventListener('click', signIn);
  return b;
}

export function renderAccount(root: HTMLElement, view: AccountView): void {
  const { me } = view;
  const parts: HTMLElement[] = [];
  if (view.kind === 'player') {
    const who = me.user?.name ?? me.user?.email ?? 'Opper user';
    parts.push(el('span', `Signed in as ${who}${me.projectName ? ` · ${me.projectName}` : ''}`));
    const wallet = el('a', 'My Opper wallet ↗');
    wallet.href = me.walletUrl;
    wallet.target = '_blank';
    wallet.rel = 'noopener';
    parts.push(wallet);
    const out = el('button', 'Sign out');
    out.addEventListener('click', () => void signOut());
    parts.push(out);
  } else if (view.kind === 'dev') {
    parts.push(el('span', 'Playing with the local dev key from .env'));
    if (me.loginAvailable) parts.push(signInButton(me));
  } else if (view.kind === 'demo') {
    parts.push(el('span', 'Recorded demo — sign in with Opper to let jev play live (calls bill your own Opper wallet)'));
    parts.push(signInButton(me));
  } else {
    parts.push(el('span', 'Signed out — sign in with Opper to keep jev playing'));
    parts.push(signInButton(me));
  }
  root.dataset.kind = view.kind;
  root.replaceChildren(...parts);
}
```

`index.html`: insert `<div id="account" class="account" aria-live="polite"></div>` as the first child of `<section class="game">`.

`src/style.css` — append:

```css
.account { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; font-size: 13px; color: var(--muted); min-height: 32px; }
.account a { color: var(--accent); }
.account .signin { background: var(--accent); color: #111; border-color: var(--accent); font-weight: 600; }
.account .signin:disabled { opacity: 0.5; cursor: not-allowed; }
.account[data-kind='demo'], .account[data-kind='signed-out'] { color: var(--text); }
```

`src/main.ts` — at the top, after the imports, add `import { fetchMe, renderAccount, takeAuthError } from './auth';` and replace `import { httpTransport } from './transport';` with `import { createHttpTransport } from './transport';`. After the `panel` is created:

```ts
const accountEl = $('#account');
const me = await fetchMe();
renderAccount(accountEl, { kind: me.mode === 'player' ? 'player' : me.mode === 'dev' ? 'dev' : 'demo', me });
const authError = takeAuthError();
if (authError) panel.handle({ type: 'error', message: authError });
const transport = createHttpTransport({
  onSignedOut: () => renderAccount(accountEl, { kind: 'signed-out', me: { ...me, mode: 'none' } }),
  onWalletEmpty: () => {},
});
```

and change the `Scheduler` construction to use `transport`. (Task 6 adds demo mode; until then `mode: 'none'` runs the live game, which shows the signed-out 401 banner and fallbacks — acceptable intermediate state.) The 402 message already reaches the panel banner via the scheduler's error event; the wallet link is in the account bar for players.

- [ ] **Step 4:** `npm test && npm run typecheck && npx vite build --outDir /private/tmp/claude-501/jevman-build --emptyOutDir` → PASS.
- [ ] **Step 5:** `git add -A src index.html tests && git commit -m "Show the Opper account and react to signed-out players"`

---

### Task 5: Recording and replay

**Files:** Create `src/replay.ts`; Modify `scripts/bench.ts`; Test `tests/replay.test.ts`.

**Produces:** `interface Recording { version: 1; recordedAt: string; model: string; frames: number[]; decisions: [number, string, Dir][]; events: [number, SchedulerEvent][]; final: { score: number; lives: number; level: number; frames: number } }`, `class Replay { readonly state: GameState; frame: number; constructor(rec: Recording); get done(): boolean; stepFrame(): SchedulerEvent[] }`, `roundDt(dt: number): number` (0.1 ms), `class Recorder { frames; decisions; events; wrap(ctl: Controls, frame: () => number): Controls; finish(state, model): Recording }`.

- [ ] **Step 1: Failing tests** — `tests/replay.test.ts`:

```ts
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { greedyChoice, optionFeatures } from '../src/features';
import { Recorder, Replay, roundDt, type Recording } from '../src/replay';
import { createGame, step } from '../src/sim';

/** Plays a greedy game while recording, like `npm run bench -- --record`, but offline. */
function recordGreedy(frames: number): Recording {
  const state = createGame();
  const rec = new Recorder();
  let frame = 0;
  const ctl = rec.wrap({ decide: (p) => greedyChoice(state, p, optionFeatures(state, p)) }, () => frame);
  for (; frame < frames && state.status !== 'gameover'; frame++) {
    const dt = roundDt(1 / 60 + (frame % 3) * 0.0011);
    rec.frames.push(dt);
    step(state, dt, ctl);
  }
  return rec.finish(state, 'greedy');
}

describe('Replay', () => {
  it('replays a recording to the same final state', () => {
    const rec = recordGreedy(1500);
    expect(rec.decisions.length).toBeGreaterThan(20);
    const replay = new Replay(rec);
    while (!replay.done) replay.stepFrame();
    expect({ score: replay.state.score, lives: replay.state.lives, level: replay.state.level, frames: replay.frame }).toEqual(rec.final);
  });

  it('hands out recorded events at their frame', () => {
    const rec: Recording = { ...recordGreedy(10), events: [[2, { type: 'error', message: 'x' }]] };
    const replay = new Replay(rec);
    expect(replay.stepFrame()).toEqual([]);
    expect(replay.stepFrame()).toEqual([]);
    expect(replay.stepFrame()).toEqual([{ type: 'error', message: 'x' }]);
  });

  const DEMO = new URL('../public/demo/jev-demo.json', import.meta.url);
  it.skipIf(!existsSync(DEMO))('replays the committed jev demo exactly (re-record if this fails after a sim change)', () => {
    const rec = JSON.parse(readFileSync(DEMO, 'utf8')) as Recording;
    const replay = new Replay(rec);
    while (!replay.done) replay.stepFrame();
    expect({ score: replay.state.score, lives: replay.state.lives, level: replay.state.level, frames: replay.frame }).toEqual(rec.final);
  });
});
```

- [ ] **Step 2:** `npx vitest run tests/replay.test.ts` → FAIL.
- [ ] **Step 3: Implement** `src/replay.ts`:

```ts
import type { SchedulerEvent } from './scheduler';
import { createGame, step, type Controls, type GameState } from './sim';
import type { Dir } from './types';

export interface Recording {
  version: 1;
  recordedAt: string;
  model: string;
  /** Each frame's simulation step in seconds, rounded with roundDt. */
  frames: number[];
  /** Every non-null direction Controls.decide returned: [frame, decision key, direction]. */
  decisions: [number, string, Dir][];
  /** Scheduler events for the panel: [frame, event]. */
  events: [number, SchedulerEvent][];
  final: { score: number; lives: number; level: number; frames: number };
}

/** Steps are stored to 0.1 ms; recording and replay both step with the rounded value. */
export const roundDt = (dt: number): number => Math.round(dt * 10_000) / 10_000;

export class Recorder {
  readonly frames: number[] = [];
  readonly decisions: [number, string, Dir][] = [];
  readonly events: [number, SchedulerEvent][] = [];

  wrap(ctl: Controls, frame: () => number): Controls {
    return {
      decide: (point) => {
        const choice = ctl.decide(point);
        if (choice !== null) this.decisions.push([frame(), point.key, choice]);
        return choice;
      },
    };
  }

  finish(state: GameState, model: string): Recording {
    return {
      version: 1,
      recordedAt: new Date().toISOString(),
      model,
      frames: this.frames,
      decisions: this.decisions,
      events: this.events,
      final: { score: state.score, lives: state.lives, level: state.level, frames: this.frames.length },
    };
  }
}

/** Re-runs a recorded game: same steps, same answers, so the same game. */
export class Replay {
  readonly state: GameState = createGame();
  frame = 0;
  /** Per frame+key, the answers decide() returned, in call order (a key can be asked several times per frame). */
  private readonly choices = new Map<string, Dir[]>();
  private readonly eventsByFrame = new Map<number, SchedulerEvent[]>();

  constructor(private readonly rec: Recording) {
    for (const [f, key, dir] of rec.decisions) this.choices.set(`${f}|${key}`, [...(this.choices.get(`${f}|${key}`) ?? []), dir]);
    for (const [f, e] of rec.events) this.eventsByFrame.set(f, [...(this.eventsByFrame.get(f) ?? []), e]);
  }

  get done(): boolean {
    return this.frame >= this.rec.frames.length;
  }

  /** Advances one recorded frame and returns the panel events recorded for it. */
  stepFrame(): SchedulerEvent[] {
    const f = this.frame;
    step(this.state, this.rec.frames[f], { decide: (p) => this.choices.get(`${f}|${p.key}`)?.shift() ?? null });
    this.frame += 1;
    return this.eventsByFrame.get(f) ?? [];
  }
}
```

`scripts/bench.ts`:
- add `record: { type: 'string' }` to `parseArgs` options and document `[--record path.json]` in the header comment;
- if `values.record` is set, require `games === 1` (`console.error` + `process.exit(1)` otherwise);
- in `playOne`, create `const recorder = values.record ? new Recorder() : null;` and a `frame` counter; push every scheduler event: in `onEvent` add `recorder?.events.push([frame, e]);` as the first line;
- wrap the controls: `const ctl = recorder ? recorder.wrap(baseCtl, () => frame) : baseCtl;` where `baseCtl` is the existing `ctl` object (renamed);
- inside the loop, after computing `dt`: `if (recorder) { dt = roundDt(dt); recorder.frames.push(dt); }`, and `frame += 1` at the end of each iteration (after `step`, after the invariant check);
- after the loop: `if (recorder) writeFileSync(values.record!, JSON.stringify(recorder.finish(state, 'typesafe/jev-1.13.0')));` plus a log line with the file size; `mkdirSync(dirname(values.record!), { recursive: true })` first. Import `writeFileSync, mkdirSync` from `node:fs`, `dirname` from `node:path`, `Recorder, roundDt` from `../src/replay`.

- [ ] **Step 4:** `npm test && npm run typecheck` → PASS (the committed-demo test is skipped until Task 7).
- [ ] **Step 5:** `git add src/replay.ts scripts/bench.ts tests/replay.test.ts && git commit -m "Record jev games in the bench and replay them deterministically"`

---

### Task 6: Demo mode in the page

**Files:** Modify `src/main.ts`, `src/style.css`.

**Consumes:** Tasks 4–5.

Behaviour: if `me.mode === 'none'`, fetch `/demo/jev-demo.json`; on success run **demo mode**; on failure (404) fall back to the live game with the signed-out bar.

- [ ] **Step 1: Implement** in `src/main.ts`:
  - `let demo: { replay: Replay; acc: number; endAt: number | null; rec: Recording } | null = null;` — when `me.mode === 'none'`: `const rec = await fetch('/demo/jev-demo.json').then((r) => (r.ok ? r.json() : null)).catch(() => null);` then `if (rec) demo = { replay: new Replay(rec), acc: 0, endAt: null, rec };`.
  - When `demo` is set: `state = demo.replay.state` (so render/HUD/panel read the replay), disable `#toggle-pacman`, `#restart`, `#speed` (`disabled = true`, `title = 'Sign in to play live'`), keep Pause, and make `J`/`R` no-ops in the keydown handler while `demo !== null`.
  - In `frame()`, branch: if `demo` and not paused:
    ```ts
    if (demo.replay.done) {
      demo.endAt ??= now;
      if (now - demo.endAt > 3000) {
        demo = { replay: new Replay(demo.rec), acc: 0, endAt: null, rec: demo.rec };
        state = demo.replay.state;
        panel = new Panel($('#panel'));
      }
    } else {
      demo.acc += dt;
      while (!demo.replay.done && demo.acc >= demo.rec.frames[demo.replay.frame]) {
        demo.acc -= demo.rec.frames[demo.replay.frame];
        for (const e of demo.replay.stepFrame()) panel.handle(e);
      }
    }
    ```
    else run the existing live branch (`clockMs`, `scheduler.update`, `step`). Rendering, `panel.updateActors(state)` and `updateHud()` stay shared. Make `panel` a `let` and the scheduler's `onEvent` call `panel.handle(e)` through the variable.
  - Render the account bar with `kind: 'demo'` when demo mode is active, `kind: 'signed-out'` when `me.mode === 'none'` but no recording was found.
- [ ] **Step 2: Style** — append to `src/style.css`: `button:disabled { opacity: 0.45; cursor: not-allowed; }`.
- [ ] **Step 3:** `npm test && npm run typecheck && npx vite build --outDir /private/tmp/claude-501/jevman-build --emptyOutDir` → PASS.
- [ ] **Step 4:** `git add src && git commit -m "Play a recorded jev game for signed-out visitors"`

---

### Task 7 (controller): record the demo, README, end-to-end

- [ ] **Step 1: Record** (paid, ~$0.03): `npm run bench -- --games 1 --pacman jev --ghosts jev --max 90 --record public/demo/jev-demo.json`. Re-record if the game is dull (score < 1500 or < 45 s). Run `npx vitest run tests/replay.test.ts` — the committed-demo test must now run and pass. Commit `public/demo/jev-demo.json` ("Add recorded jev demo game").
- [ ] **Step 2: README** — rewrite "Run" into two options: **A. Login with Opper** (register an OAuth app at Opper with redirect `http://localhost:5173/auth/callback`; set `OPPER_CLIENT_ID`, `OPPER_CLIENT_SECRET`, `SESSION_SECRET`; each player signs in and jev calls bill their own Opper wallet; signed-out visitors see the recorded demo) and **B. Your own key in `.env`** (`OPPER_API_KEY`, local dev only). Add **Cost** with rough numbers measured in Step 3: cost per call, per typical game (all characters on jev, ~1 minute), per hour. Document `npm run bench -- --record`. Commit ("README: Login with Opper, .env key option and cost per game").
- [ ] **Step 3: End-to-end** in the Zellij `dev` tab + built-in browser (the user signs in themselves; Claude never types credentials):
  1. Without session, with `OPPER_API_KEY= npm run dev` (dev key hidden): demo plays and loops, account bar says "Recorded demo", toggle/restart/speed disabled, no `/api/decide` calls, no console errors.
  2. Click **Sign in with Opper** → user signs in → back on `/` with "Signed in as …"; live game; dev log shows `[jev player] … ok` lines; panel shows jev decisions; note calls/cost for one full game for the README.
  3. Sign out → demo again; `/api/me` says `none`.
  4. Tamper with the cookie (devtools / JS: set `jevman_session=garbage` is impossible for httpOnly from JS — instead restart the server with a different `SESSION_SECRET`): page shows the demo (signed out), no 500s.
  5. Normal `npm run dev` with the dev key and no session: "Playing with the local dev key" and live game as before.
  6. `npm test`, `npm run typecheck`, `npm run smoke`.
- [ ] **Step 4:** Stop the dev server (Ctrl-C the recorded pane), confirm port 5173 is free.
