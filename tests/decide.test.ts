import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { handleDecide, JEV_MODEL, jevPlugin, type DecideDeps } from '../server/decide';

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

describe('jevPlugin middleware', () => {
  function mount(logger: { info: () => void; warn: () => void; error: () => void }) {
    let handler!: (req: EventEmitter & { method: string; headers: Record<string, string> }, res: unknown) => void;
    const plugin = jevPlugin({ OPPER_API_KEY: 'test-key', OPPER_BASE_URL: 'https://api.opper.ai' });
    (plugin.configureServer as (s: unknown) => void)({
      config: { logger },
      middlewares: { use: (_path: string, h: typeof handler) => (handler = h) },
    });
    return handler;
  }

  it('answers 500 and ends the response when handling throws, instead of hanging', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('boom');
    });
    const error = vi.fn();
    const handler = mount({
      info: () => {
        throw new Error('logger exploded with test-key');
      },
      warn: () => {},
      error,
    });
    const headers: Record<string, string> = {};
    const res = {
      statusCode: 200,
      headersSent: false,
      setHeader: (k: string, v: string) => (headers[k] = v),
      end: vi.fn((_chunk?: string) => (res.headersSent = true)),
    };
    const req = Object.assign(new EventEmitter(), { method: 'POST', headers: { 'content-type': 'application/json' } });
    handler(req, res);
    req.emit('data', JSON.stringify(body));
    req.emit('end');
    await vi.waitFor(() => expect(res.end).toHaveBeenCalled());
    vi.unstubAllGlobals();
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.end.mock.calls[0][0] as unknown as string)).toEqual({ error: 'internal error in /api/decide' });
    expect(JSON.stringify(error.mock.calls)).not.toContain('test-key');
  });

  it('answers 405 to non-POST requests', () => {
    const handler = mount({ info: () => {}, warn: () => {}, error: () => {} });
    const res = { statusCode: 200, end: vi.fn() };
    handler(Object.assign(new EventEmitter(), { method: 'GET', headers: {} }), res);
    expect(res.statusCode).toBe(405);
    expect(res.end).toHaveBeenCalled();
  });

  it.each([['text/plain'], [undefined]])('answers 415 without calling jev for Content-Type %s (CSRF guard)', (contentType) => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const handler = mount({ info: () => {}, warn: () => {}, error: () => {} });
    const headers: Record<string, string> = {};
    const res = { statusCode: 200, setHeader: (k: string, v: string) => (headers[k] = v), end: vi.fn() };
    const req = Object.assign(new EventEmitter(), { method: 'POST', headers: (contentType ? { 'content-type': contentType } : {}) as Record<string, string> });
    handler(req, res);
    vi.unstubAllGlobals();
    expect(res.statusCode).toBe(415);
    expect(JSON.parse(res.end.mock.calls[0][0] as string)).toEqual({ error: 'Expected application/json' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
