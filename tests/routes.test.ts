import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SESSION_COOKIE } from '../server/auth';
import { jevPlugin } from '../server/plugin';
import { authConfigFromEnv, createJevMiddleware, devKeyFromEnv, MAX_BODY_BYTES } from '../server/routes';
import { sealSession } from '../server/session';

const SECRET = 's'.repeat(64);
const decideBody = { state: { maze: ['#'] }, questions: { blinky: { type: 'choice', instructions: 'chase', criteria: { left: 'a', up: 'b' } } } };
const JSON_POST = { 'content-type': 'application/json' };
type Req = EventEmitter & { method: string; url: string; headers: Record<string, string> };
const newLogger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

function mount(env: Record<string, string>, logger = newLogger(), opts: { quiet?: boolean } = { quiet: true }) {
  const handler = createJevMiddleware({ SESSION_SECRET: SECRET, OPPER_BASE_URL: 'https://api.opper.ai', ...env }, logger, opts);
  return { handler, logger };
}

function fakeRes(setHeader?: (k: string, v: string | string[]) => void) {
  const headers: Record<string, string | string[]> = {};
  const res = {
    statusCode: 200,
    headersSent: false,
    setHeader: setHeader ?? ((k: string, v: string | string[]) => (headers[k] = v)),
    end: vi.fn((_chunk?: string) => (res.headersSent = true)),
    headers,
  };
  return res;
}

function call(handler: ReturnType<typeof mount>['handler'], method: string, url: string, headers: Record<string, string> = {}, payload?: unknown, res = fakeRes()) {
  const next = vi.fn();
  const req = Object.assign(new EventEmitter(), { method, url, headers }) as Req;
  handler(req as never, res as never, next);
  if (payload !== undefined) {
    req.emit('data', typeof payload === 'string' ? payload : JSON.stringify(payload));
    req.emit('end');
  }
  return { res, next, req };
}

const bodyOf = (res: ReturnType<typeof fakeRes>) => JSON.parse(res.end.mock.calls[0][0] as string);

afterEach(() => vi.unstubAllGlobals());

describe('jevPlugin', () => {
  it('mounts the middleware on both the dev server and the preview server', () => {
    const plugin = jevPlugin({ SESSION_SECRET: SECRET }, { quiet: true });
    for (const hook of [plugin.configureServer, plugin.configurePreviewServer]) {
      const use = vi.fn();
      (hook as (s: unknown) => void)({ config: { logger: newLogger() }, middlewares: { use } });
      expect(use).toHaveBeenCalledOnce();
      const res = fakeRes();
      (use.mock.calls[0][0] as ReturnType<typeof mount>['handler'])(Object.assign(new EventEmitter(), { method: 'GET', url: '/api/me', headers: {} }) as never, res as never, vi.fn());
      expect(bodyOf(res)).toMatchObject({ mode: 'none' });
    }
  });
});

describe('createJevMiddleware routing', () => {
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
    expect(bodyOf(res)).toMatchObject({ mode: 'dev', loginAvailable: false });
  });

  it('asks the player to sign in when there is no session and no dev key, before reading the body', () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const { handler } = mount({});
    const { res } = call(handler, 'POST', '/api/decide', JSON_POST);
    expect(res.end).toHaveBeenCalledOnce();
    expect(res.statusCode).toBe(401);
    expect(bodyOf(res)).toEqual({ error: 'Sign in with Opper to let jev play', signedOut: true });
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
    const { res } = call(handler, 'POST', '/api/decide', { ...JSON_POST, cookie }, decideBody);
    await vi.waitFor(() => expect(res.end).toHaveBeenCalled());
    expect(auth).toEqual(['Bearer op-player']);
    expect(res.statusCode).toBe(401);
    expect(bodyOf(res)).toEqual({ error: 'Your Opper sign-in has expired — sign in again', signedOut: true });
    expect(String(res.headers['Set-Cookie'])).toMatch(new RegExp(`^${SESSION_COOKIE}=; Max-Age=0`));
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain('op-player');
  });

  it('answers 500 and ends the response when handling throws, instead of hanging', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('boom');
    });
    const logger = { info: vi.fn(() => { throw new Error('logger exploded with op-dev'); }), warn: vi.fn(), error: vi.fn() };
    const { handler } = mount({ OPPER_API_KEY: 'op-dev' }, logger);
    const { res } = call(handler, 'POST', '/api/decide', JSON_POST, decideBody);
    await vi.waitFor(() => expect(res.end).toHaveBeenCalled());
    expect(res.statusCode).toBe(500);
    expect(bodyOf(res)).toEqual({ error: 'internal error in /api/decide' });
    expect(logger.error).toHaveBeenCalled();
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('op-dev');
  });

  it('answers 413 without calling jev when the body is larger than 256 KB', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const { handler } = mount({ OPPER_API_KEY: 'op-dev' });
    const { res, req } = call(handler, 'POST', '/api/decide', JSON_POST);
    req.emit('data', Buffer.alloc(MAX_BODY_BYTES, 0x20));
    req.emit('data', Buffer.from('{}'));
    req.emit('end');
    await vi.waitFor(() => expect(res.end).toHaveBeenCalled());
    expect(MAX_BODY_BYTES).toBe(256 * 1024);
    expect(res.statusCode).toBe(413);
    expect(bodyOf(res)).toEqual({ error: 'Request body too large' });
    expect(res.end).toHaveBeenCalledOnce();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('accepts a body of exactly 256 KB', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"answers":{},"usage":{"input_tokens":0,"output_tokens":0}}', { status: 200 })));
    const { handler } = mount({ OPPER_API_KEY: 'op-dev' });
    const json = JSON.stringify(decideBody);
    const { res, req } = call(handler, 'POST', '/api/decide', JSON_POST);
    req.emit('data', Buffer.from(json + ' '.repeat(MAX_BODY_BYTES - json.length)));
    req.emit('end');
    await vi.waitFor(() => expect(res.end).toHaveBeenCalled());
    expect(res.statusCode).toBe(200);
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

  it('caps the exchange-failure log line at about 300 characters', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: `shh ${'x'.repeat(5000)}` }), { status: 400 })));
    const { handler, logger } = mount({ OPPER_CLIENT_ID: 'opper_app_x', OPPER_CLIENT_SECRET: 'shh' });
    const { res } = call(handler, 'GET', '/auth/callback?code=c0de&state=st8', { cookie: 'jevman_oauth_state=st8' });
    await vi.waitFor(() => expect(res.end).toHaveBeenCalled());
    const line = String(logger.warn.mock.calls.find((c) => String(c[0]).includes('token exchange failed'))![0]);
    expect(line.length).toBeLessThanOrEqual(340);
    expect(line).toContain('[redacted]');
    expect(line).not.toContain('shh');
  });

  it('still ends the callback response when writing it throws', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"api_key":"op-player"}', { status: 200 })));
    const { handler } = mount({ OPPER_CLIENT_ID: 'opper_app_x', OPPER_CLIENT_SECRET: 'shh' });
    const res = fakeRes(() => {
      throw new Error('socket gone');
    });
    call(handler, 'GET', '/auth/callback?code=c0de&state=st8', { cookie: 'jevman_oauth_state=st8' }, undefined, res);
    await vi.waitFor(() => expect(res.end).toHaveBeenCalled());
    expect(res.statusCode).toBe(500);
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

  it.each([
    ['/api/decide', { 'sec-fetch-site': 'cross-site' }],
    ['/api/decide', { origin: 'https://evil.example', host: 'localhost:5173' }],
    ['/auth/logout', { 'sec-fetch-site': 'same-site' }],
    ['/auth/logout', { origin: 'null', host: 'localhost:5173' }],
  ])('answers 403 to a cross-site POST %s %j', (path, headers) => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const { handler } = mount({ OPPER_API_KEY: 'op-dev' });
    const { res } = call(handler, 'POST', path, { ...JSON_POST, ...headers });
    expect(res.statusCode).toBe(403);
    expect(res.headers['Set-Cookie']).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('warns that jev cannot play unless quiet', () => {
    const loud = mount({}, newLogger(), {}).logger;
    expect(JSON.stringify(loud.warn.mock.calls)).toContain('jev cannot play');
    const quiet = mount({}, newLogger(), { quiet: true }).logger;
    expect(JSON.stringify(quiet.warn.mock.calls)).not.toContain('jev cannot play');
  });
});

describe('deploy safety', () => {
  const HTTPS = { OPPER_REDIRECT_URI: 'https://jevman.example/auth/callback', OPPER_CLIENT_ID: 'opper_app_x', OPPER_CLIENT_SECRET: 'shh' };

  it.each([[undefined], ['short']])('refuses to start with an https redirect URI and SESSION_SECRET %s', (secret) => {
    const env: Record<string, string> = { ...HTTPS };
    if (secret) env.SESSION_SECRET = secret;
    expect(() => authConfigFromEnv(env, vi.fn())).toThrow(/SESSION_SECRET/);
    expect(() => createJevMiddleware(env, newLogger(), { quiet: true })).toThrow(/SESSION_SECRET/);
  });

  it('accepts a 32-character SESSION_SECRET with an https redirect URI', () => {
    const warn = vi.fn();
    expect(authConfigFromEnv({ ...HTTPS, SESSION_SECRET: 'k'.repeat(32) }, warn).sessionSecret).toBe('k'.repeat(32));
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns once and uses a random secret over http when login is configured', () => {
    const warn = vi.fn();
    const cfg = authConfigFromEnv({ SESSION_SECRET: 'short', OPPER_CLIENT_ID: 'opper_app_x', OPPER_CLIENT_SECRET: 'shh' }, warn);
    expect(cfg.sessionSecret).toHaveLength(64);
    expect(warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('SESSION_SECRET'))).toHaveLength(1);
  });

  it('does not warn about SESSION_SECRET in dev when login is not configured', () => {
    const warn = vi.fn();
    expect(authConfigFromEnv({ OPPER_API_KEY: 'op-dev' }, warn).sessionSecret).toHaveLength(64);
    expect(warn).not.toHaveBeenCalled();
  });

  it('ignores the dev key with a warning when the redirect URI is https', () => {
    const env = { ...HTTPS, SESSION_SECRET: SECRET, OPPER_API_KEY: 'op-dev' };
    const warn = vi.fn();
    expect(devKeyFromEnv(env, authConfigFromEnv(env, vi.fn()), warn)).toBeUndefined();
    expect(String(warn.mock.calls[0][0])).toMatch(/OPPER_API_KEY.*ignored.*JEV_ALLOW_DEV_KEY=1/);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('op-dev');

    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const { handler } = mount(env);
    expect(bodyOf(call(handler, 'GET', '/api/me').res)).toMatchObject({ mode: 'none' });
    const { res } = call(handler, 'POST', '/api/decide', JSON_POST);
    expect(res.statusCode).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('uses the dev key over https only with JEV_ALLOW_DEV_KEY=1, still warning', () => {
    const env = { ...HTTPS, SESSION_SECRET: SECRET, OPPER_API_KEY: 'op-dev', JEV_ALLOW_DEV_KEY: '1' };
    const warn = vi.fn();
    expect(devKeyFromEnv(env, authConfigFromEnv(env, vi.fn()), warn)).toBe('op-dev');
    expect(warn).toHaveBeenCalledOnce();
  });

  it('uses the dev key over http without a warning', () => {
    const env = { SESSION_SECRET: SECRET, OPPER_API_KEY: 'op-dev' };
    const warn = vi.fn();
    expect(devKeyFromEnv(env, authConfigFromEnv(env, vi.fn()), warn)).toBe('op-dev');
    expect(warn).not.toHaveBeenCalled();
  });
});
