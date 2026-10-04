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
    if (why === 'state') expect(exchange).not.toHaveBeenCalled();
    expect(setCookies(r).some((c) => c.startsWith(`${SESSION_COOKIE}=`) && !c.includes('Max-Age=0'))).toBe(false);
  });
  it.each([
    ['unparseable', 'not-a-date'],
    ['already past', new Date(9_000).toISOString()],
  ])('rejects a %s key expiry without setting a session', async (_name, expiresAt) => {
    const r = await handleCallback(withState('/auth/callback?code=c&state=st4te'), cfg, async () => ({ apiKey: 'op-player', user: {}, expiresAt }), 10_000);
    expect(r.headers.Location).toBe('/?auth_error=exchange');
    expect(setCookies(r).some((c) => c.startsWith(`${SESSION_COOKIE}=`) && !c.includes('Max-Age=0'))).toBe(false);
  });
  it.each(['/auth/callback?x=%', 'http://', '//'])('resolves to auth_error=state for the malformed URL %s', async (url) => {
    const exchange = vi.fn(async () => ({ apiKey: 'op-player', user: {} }));
    const r = await handleCallback(withState(url), cfg, exchange);
    expect(r.headers.Location).toBe('/?auth_error=state');
    expect(exchange).not.toHaveBeenCalled();
  });
  it('marks both cookies Secure for an https redirect URI', async () => {
    const httpsCfg = { ...cfg, redirectUri: 'https://jevman.example/auth/callback' };
    const login = handleLogin(req('/auth/login'), httpsCfg, () => 'st4te');
    expect(setCookies(login)[0]).toMatch(/; HttpOnly; Secure; SameSite=Lax$/);
    const r = await handleCallback(withState('/auth/callback?code=c&state=st4te'), httpsCfg, async () => ({ apiKey: 'op-player', user: {} }), 10_000);
    const cookies = setCookies(r);
    expect(cookies.find((c) => c.startsWith(`${SESSION_COOKIE}=`))).toMatch(/HttpOnly; Secure; SameSite=Lax$/);
    expect(cookies.find((c) => c.startsWith(`${STATE_COOKIE}=`))).toMatch(/HttpOnly; Secure; SameSite=Lax$/);
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
    expect(init.redirect).toBe('error');
    expect(init.signal).toBeInstanceOf(AbortSignal);
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
    expect(r.headers['Cache-Control']).toBe('no-store');
    const notPost = handleLogout(signedIn('/auth/logout'), cfg);
    expect(notPost.status).toBe(405);
    expect(notPost.headers.Allow).toBe('POST');
    expect(notPost.headers['Cache-Control']).toBe('no-store');
  });
  it('describes the account without the key', () => {
    const player = JSON.parse(handleMe(signedIn('/api/me'), cfg, true).body);
    expect(player).toEqual({ mode: 'player', user: { name: 'Ada' }, projectName: 'jevman', walletUrl: 'https://platform.opper.ai/wallet', loginAvailable: true });
    expect(JSON.parse(handleMe(req('/api/me'), cfg, true).body).mode).toBe('dev');
    expect(JSON.parse(handleMe(req('/api/me'), { ...cfg, clientId: undefined }, false).body)).toMatchObject({ mode: 'none', loginAvailable: false });
    expect(handleMe(signedIn('/api/me'), cfg, true).body).not.toContain('op-player');
    expect(handleMe(signedIn('/api/me'), cfg, true).headers['Cache-Control']).toBe('no-store');
  });
});
