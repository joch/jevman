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

  it('logs the redacted exchange failure reason and redirects to auth_error=exchange', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"bad secret shh"}', { status: 400 })));
    const { handler, logger } = mount({ OPPER_CLIENT_ID: 'opper_app_x', OPPER_CLIENT_SECRET: 'shh' });
    const { res } = call(handler, 'GET', '/auth/callback?code=c0de&state=st8', { cookie: 'jevman_oauth_state=st8' });
    await vi.waitFor(() => expect(res.end).toHaveBeenCalled());
    expect(res.statusCode).toBe(302);
    expect(String(res.headers.Location)).toBe('/?auth_error=exchange');
    const logged = JSON.stringify(logger.warn.mock.calls);
    expect(logged).toContain('token exchange failed');
    expect(logged).not.toContain('shh');
    expect(logged).not.toContain('c0de');
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
