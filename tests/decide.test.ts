import { describe, expect, it, vi } from 'vitest';
import { handleDecide, JEV_MODEL, resolveKey, type DecideDeps } from '../server/decide';

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
    expect((res.body as { error: string }).error).toBe('jev returned HTTP 529: TypeSafe is temporarily overloaded');
    expect(log).toHaveBeenCalled();
  });

  it('reports timeouts as 504', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => {
      throw Object.assign(new Error('aborted'), { name: 'TimeoutError' });
    });
    const res = await handleDecide(body, deps(fetchMock, { timeoutMs: 2000 }));
    expect(res.status).toBe(504);
    expect((res.body as { error: string }).error).toBe('jev timed out after 2000 ms');
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
