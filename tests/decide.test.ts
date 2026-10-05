import { describe, expect, it, vi } from 'vitest';
import { SESSION_COOKIE, type AuthConfig, type HttpRequest } from '../server/auth';
import type { JevTarget } from '../server/jev';
import { handleDecide, handleDecideRequest, JEV_MODEL, rejectDecideRequest, resolveKey, WARM_TIMEOUT_MS, type DecideDeps } from '../server/decide';
import { sealSession } from '../server/session';

const body = {
  state: { maze: ['#'] },
  questions: { blinky: { type: 'choice', instructions: 'chase', criteria: { left: 'a', up: 'b' } } },
};

const answers = { blinky: { type: 'choice', choice: 'up', confidence: 0.9, probabilities: { up: 0.9, left: 0.1 } } };

function deps(fetchImpl: DecideDeps['fetch'], overrides: Partial<DecideDeps> = {}): DecideDeps {
  let t = 1000;
  return { apiKey: 'test-key', baseUrl: 'https://api.opper.ai', fetch: fetchImpl, now: () => (t += 170), ...overrides };
}

const ok = () =>
  vi.fn<typeof fetch>(async () =>
    new Response(JSON.stringify({ model: 'jev-1.13.0', answers, usage: { input_tokens: 5, output_tokens: 2 } }), {
      status: 200,
      headers: { 'x-opper-cost': '0.00002', 'x-opper-trace-id': 'trace-1' },
    }),
  );

describe('handleDecide', () => {
  it('forwards to System One with the key and model and returns answers, usage, cost and latency', async () => {
    const fetchMock = ok();
    const res = await handleDecide(body, deps(fetchMock));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      model: 'typesafe/jev-1.13.0',
      answers,
      usage: { input_tokens: 5, output_tokens: 2 },
      latencyMs: 170,
      costUsd: 0.00002,
      traceId: 'trace-1',
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.opper.ai/v3/compat/v1/systemone');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer test-key');
    expect(headers['X-Opper-Name']).toBe('jevman-decide');
    expect(JSON.parse(init.body as string)).toEqual({ model: JEV_MODEL, ...body });
  });

  it('tolerates a trailing slash in the base URL', async () => {
    const fetchMock = ok();
    await handleDecide(body, deps(fetchMock, { baseUrl: 'https://api.opper.ai/' }));
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.opper.ai/v3/compat/v1/systemone');
  });

  it('refuses to call jev without a key', async () => {
    const fetchMock = ok();
    const res = await handleDecide(body, deps(fetchMock, { apiKey: undefined }));
    expect(res.status).toBe(500);
    expect((res.body as { error: string }).error).toMatch(/OPPER_API_KEY/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects malformed requests', async () => {
    const res = await handleDecide({ state: {} }, deps(ok()));
    expect(res.status).toBe(400);
  });

  it('passes upstream errors through as 502 with the upstream status', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ error: 'TypeSafe is temporarily overloaded' }), { status: 529 }));
    const log = vi.fn();
    const res = await handleDecide(body, deps(fetchMock, { log }));
    expect(res.status).toBe(502);
    expect((res.body as { error: string }).error).toBe('jev 1.13 returned HTTP 529: TypeSafe is temporarily overloaded');
    expect(log).toHaveBeenCalled();
  });

  it('reports timeouts as 504', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => {
      throw Object.assign(new Error('aborted'), { name: 'TimeoutError' });
    });
    const res = await handleDecide(body, deps(fetchMock, { timeoutMs: 2000 }));
    expect(res.status).toBe(504);
    expect((res.body as { error: string }).error).toBe('jev 1.13 timed out after 2000 ms');
  });

  it('never includes the key in error output', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => {
      throw new Error('connect ECONNREFUSED');
    });
    const log = vi.fn();
    const res = await handleDecide(body, deps(fetchMock, { log }));
    expect(JSON.stringify(res.body)).not.toContain('test-key');
    expect(JSON.stringify(log.mock.calls)).not.toContain('test-key');
  });

  it('redacts the key from thrown error messages before returning or logging them', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => {
      throw new Error('bad header Authorization: Bearer test-key and again test-key');
    });
    const log = vi.fn();
    const res = await handleDecide(body, deps(fetchMock, { log }));
    expect(res.status).toBe(502);
    expect(JSON.stringify(res.body)).not.toContain('test-key');
    expect(JSON.stringify(log.mock.calls)).not.toContain('test-key');
    expect((res.body as { error: string }).error).toContain('[redacted]');
  });

  it('redacts the key from upstream error bodies before returning or logging them', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response('invalid key test-key (test-key)', { status: 401 }));
    const log = vi.fn();
    const res = await handleDecide(body, deps(fetchMock, { log }));
    expect(res.status).toBe(502);
    expect(JSON.stringify(res.body)).not.toContain('test-key');
    expect(JSON.stringify(log.mock.calls)).not.toContain('test-key');
    expect((res.body as { error: string }).error).toContain('[redacted]');
  });
});

describe('player keys', () => {
  const upstream = (status: number) => vi.fn<typeof fetch>(async () => new Response('{"error":"x"}', { status }));
  it.each([
    [401, 401, { error: 'Your Opper sign-in has expired — sign in again', signedOut: true, clearSession: true }],
    [402, 402, { error: 'Your Opper wallet is empty — top up to keep playing', walletUrl: 'https://platform.opper.ai/wallet' }],
    [403, 403, { error: 'typesafe/jev-1.13.0 is not enabled for your Opper account' }],
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
  const opperDev: JevTarget = { provider: 'opper', apiKey: 'op-dev', baseUrl: 'https://api.opper.ai' };
  const typesafeDev: JevTarget = { provider: 'typesafe', apiKey: 'ts-dev', baseUrl: 'https://api.typesafe.ai' };
  it('prefers the signed-in player (always via Opper), then the dev key, else none', () => {
    expect(resolveKey(session, typesafeDev, 'https://api.opper.ai')).toEqual({ apiKey: 'op-player', mode: 'player', provider: 'opper', baseUrl: 'https://api.opper.ai' });
    expect(resolveKey(null, opperDev, 'https://api.opper.ai')).toEqual({ ...opperDev, mode: 'dev' });
    expect(resolveKey(null, typesafeDev, 'https://api.opper.ai')).toEqual({ ...typesafeDev, mode: 'dev' });
    expect(resolveKey(null, undefined, 'https://api.opper.ai')).toBeNull();
  });
});

describe('handleDecideRequest', () => {
  const DEV: JevTarget = { provider: 'opper', apiKey: 'op-dev', baseUrl: 'https://api.opper.ai' };
  const cfg: AuthConfig = { redirectUri: 'http://localhost:5173/auth/callback', opperUrl: 'https://api.opper.ai', sessionSecret: 's'.repeat(64) };
  const playerCookie = () => `${SESSION_COOKIE}=${encodeURIComponent(sealSession({ v: 1, apiKey: 'op-player', user: {}, issuedAt: Date.now() }, cfg.sessionSecret))}`;
  const post = (headers: HttpRequest['headers'] = {}, method = 'POST'): HttpRequest => ({ method, url: '/api/decide', headers: { 'content-type': 'application/json', ...headers } });
  const run = (req: HttpRequest, raw: string, devKey: JevTarget | undefined, fetchImpl: typeof fetch = ok(), extra: { log?: (l: string) => void; logError?: (l: string) => void } = {}) =>
    handleDecideRequest(req, raw, cfg, devKey, { fetch: fetchImpl, now: () => 0, ...extra });

  it('answers 405 with Allow for anything but POST', async () => {
    const r = await run(post({}, 'GET'), '', DEV);
    expect(r.status).toBe(405);
    expect(r.headers.Allow).toBe('POST');
  });

  it('answers 415 for a non-JSON body (CSRF guard)', async () => {
    const fetchMock = ok();
    expect((await run(post({ 'content-type': 'text/plain' }), JSON.stringify(body), DEV, fetchMock)).status).toBe(415);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [{ 'sec-fetch-site': 'cross-site' }],
    [{ 'sec-fetch-site': 'same-site' }],
    [{ 'sec-fetch-site': 'none' }],
    [{ origin: 'https://evil.example', host: 'localhost:5173' }],
    [{ origin: 'null', host: 'localhost:5173' }],
  ])('answers 403 for a cross-site request %j', async (headers) => {
    const fetchMock = ok();
    const r = await run(post(headers), JSON.stringify(body), DEV, fetchMock);
    expect(r.status).toBe(403);
    expect(JSON.parse(r.body)).toEqual({ error: 'Cross-site request refused' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('allows same-origin requests', async () => {
    const r = await run(post({ 'sec-fetch-site': 'same-origin', origin: 'http://localhost:5173', host: 'localhost:5173' }), JSON.stringify(body), DEV);
    expect(r.status).toBe(200);
  });

  it('answers 401 signedOut without a session or dev key', async () => {
    const fetchMock = ok();
    const r = await run(post(), JSON.stringify(body), undefined, fetchMock);
    expect(r.status).toBe(401);
    expect(JSON.parse(r.body)).toEqual({ error: 'Sign in with Opper to let the AI play', signedOut: true });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(rejectDecideRequest(post(), cfg, undefined)?.status).toBe(401);
    expect(rejectDecideRequest(post(), cfg, DEV)).toBeNull();
  });

  it('answers 400 for unparseable JSON', async () => {
    expect((await run(post(), '{nope', DEV)).status).toBe(400);
  });

  it('returns the answers as no-store JSON', async () => {
    const r = await run(post(), JSON.stringify(body), DEV);
    expect(r.status).toBe(200);
    expect(r.headers['Content-Type']).toBe('application/json');
    expect(r.headers['Cache-Control']).toBe('no-store');
    expect(JSON.parse(r.body).answers).toEqual(answers);
  });

  it('turns clearSession into a Set-Cookie that clears the session, and keeps it out of the body', async () => {
    const r = await run(post({ cookie: playerCookie() }), JSON.stringify(body), DEV, vi.fn<typeof fetch>(async () => new Response('{}', { status: 401 })));
    expect(r.status).toBe(401);
    expect(JSON.parse(r.body)).toEqual({ error: 'Your Opper sign-in has expired — sign in again', signedOut: true });
    expect(String(r.headers['Set-Cookie'])).toMatch(new RegExp(`^${SESSION_COOKIE}=; Max-Age=0`));
  });

  it('sends a signed-in player through Opper even when the dev key is a TypeSafe key', async () => {
    const TS: JevTarget = { provider: 'typesafe', apiKey: 'ts-dev', baseUrl: 'https://api.typesafe.ai' };
    const fetchMock = ok();
    const r = await run(post({ cookie: playerCookie() }), JSON.stringify(body), TS, fetchMock);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.opper.ai/v3/compat/v1/systemone');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer op-player');
    expect(JSON.stringify(init)).not.toContain('ts-dev');
    expect(r.body).not.toContain('ts-dev');
  });

  it('redacts a TypeSafe dev key from the failure log', async () => {
    const TS: JevTarget = { provider: 'typesafe', apiKey: 'ts-dev', baseUrl: 'https://api.typesafe.ai' };
    const logError = vi.fn();
    const log = () => {
      throw new Error('log failed for ts-dev');
    };
    expect((await run(post(), JSON.stringify(body), TS, ok(), { log, logError })).status).toBe(500);
    expect(JSON.stringify(logError.mock.calls)).toContain('[redacted]');
    expect(JSON.stringify(logError.mock.calls)).not.toContain('ts-dev');
  });

  it('answers 500 and logs a redacted message when handling throws', async () => {
    const logError = vi.fn();
    const log = () => {
      throw new Error('log failed for op-player and op-dev');
    };
    const r = await run(post({ cookie: playerCookie() }), JSON.stringify(body), DEV, ok(), { log, logError });
    expect(r.status).toBe(500);
    expect(JSON.parse(r.body)).toEqual({ error: 'internal error in /api/decide' });
    const logged = JSON.stringify(logError.mock.calls);
    expect(logged).toContain('[redacted]');
    expect(logged).not.toContain('op-player');
    expect(logged).not.toContain('op-dev');
  });
});

describe('warming a model up', () => {
  const DEV: JevTarget = { provider: 'opper', apiKey: 'op-dev', baseUrl: 'https://api.opper.ai' };
  const cfg: AuthConfig = { redirectUri: 'http://localhost:5173/auth/callback', opperUrl: 'https://api.opper.ai', sessionSecret: 's'.repeat(64) };
  const post: HttpRequest = { method: 'POST', url: '/api/warm', headers: { 'content-type': 'application/json' } };

  it('sends a fixed tiny question to the named model, whatever else the body holds', async () => {
    const fetchMock = ok();
    const r = await handleDecideRequest(post, JSON.stringify({ model: 'opper/clef', questions: { big: 'x'.repeat(5000) } }), cfg, DEV, { fetch: fetchMock, now: () => 0 }, { warm: true });
    expect(r.status).toBe(200);
    const sent = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(sent.model).toBe('opper/clef');
    expect(Object.keys(sent.questions)).toEqual(['warmup']);
  });

  it('waits far longer than a game call, since a cold model can take many seconds', async () => {
    // Answers after 2.2 s: past a game call's 2 s timeout, well within a warm-up's.
    const slow = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise((resolve, reject) => {
          const t = setTimeout(() => resolve(new Response(JSON.stringify({ answers: {}, usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200 })), 2200);
          init?.signal?.addEventListener('abort', () => (clearTimeout(t), reject(init.signal!.reason)));
        }),
    );
    const decide: HttpRequest = { ...post, url: '/api/decide' };
    expect((await handleDecideRequest(decide, JSON.stringify(body), cfg, DEV, { fetch: slow, now: () => 0 })).status).toBe(504);
    expect((await handleDecideRequest(post, JSON.stringify({ model: 'opper/clef' }), cfg, DEV, { fetch: slow, now: () => 0 }, { warm: true })).status).toBe(200);
    expect(WARM_TIMEOUT_MS).toBeLessThan(30_000); // leaves room in the 35 s shutdown deadline after its 5 s drain
  }, 10_000);

  it('still refuses unlisted models and cross-site requests', async () => {
    const fetchMock = ok();
    expect((await handleDecideRequest(post, JSON.stringify({ model: 'openai/gpt-5' }), cfg, DEV, { fetch: fetchMock, now: () => 0 }, { warm: true })).status).toBe(400);
    const cross = { ...post, headers: { ...post.headers, 'sec-fetch-site': 'cross-site' } };
    expect((await handleDecideRequest(cross, '{}', cfg, DEV, { fetch: fetchMock, now: () => 0 }, { warm: true })).status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
