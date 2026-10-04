import { describe, expect, it, vi } from 'vitest';
import { handleDecide, type DecideDeps } from '../server/decide';
import { devTargetFromEnv, endpointFor, modelFor, TYPESAFE_BASE_URL } from '../server/jev';

const body = { state: { maze: ['#'] }, questions: { blinky: { type: 'choice', instructions: 'chase', criteria: { left: 'a', up: 'b' } } } };
const answers = { blinky: { type: 'choice', choice: 'up', confidence: 0.9, probabilities: { up: 0.9, left: 0.1 } } };

function deps(fetchImpl: DecideDeps['fetch'], over: Partial<DecideDeps> = {}): DecideDeps {
  let t = 0;
  return { apiKey: 'ts-key', baseUrl: TYPESAFE_BASE_URL, provider: 'typesafe', fetch: fetchImpl, now: () => (t += 100), ...over };
}

describe('jev targets', () => {
  it('builds the endpoint and model for each provider', () => {
    expect(endpointFor({ provider: 'opper', apiKey: 'k', baseUrl: 'https://api.opper.ai/' })).toBe('https://api.opper.ai/v3/compat/v1/systemone');
    expect(endpointFor({ provider: 'typesafe', apiKey: 'k', baseUrl: 'https://api.typesafe.ai' })).toBe('https://api.typesafe.ai/v1/systemone');
    expect(modelFor('opper')).toBe('typesafe/jev-1.13.0');
    expect(modelFor('typesafe')).toBe('jev-1.13.0');
  });

  it('prefers TYPESAFE_API_KEY over OPPER_API_KEY and honours base URL overrides', () => {
    expect(devTargetFromEnv({ TYPESAFE_API_KEY: 'ts', OPPER_API_KEY: 'op' })).toEqual({ provider: 'typesafe', apiKey: 'ts', baseUrl: 'https://api.typesafe.ai' });
    expect(devTargetFromEnv({ TYPESAFE_API_KEY: 'ts', TYPESAFE_BASE_URL: 'https://ts.example' })).toMatchObject({ baseUrl: 'https://ts.example' });
    expect(devTargetFromEnv({ OPPER_API_KEY: 'op' })).toEqual({ provider: 'opper', apiKey: 'op', baseUrl: 'https://api.opper.ai' });
    expect(devTargetFromEnv({ OPPER_API_KEY: 'op', OPPER_BASE_URL: 'https://o.example' })).toMatchObject({ baseUrl: 'https://o.example' });
    expect(devTargetFromEnv({ TYPESAFE_API_KEY: '', OPPER_API_KEY: '' })).toBeUndefined();
  });
});

describe('handleDecide against TypeSafe directly', () => {
  it('posts to /v1/systemone with the TypeSafe model, estimates cost and reports the request id', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ model: 'jev-1.13.0', answers, usage: { input_tokens: 1000, output_tokens: 30 } }), {
        status: 200,
        headers: { 'x-typesafe-request-id': 'req_1' },
      }),
    );
    const log = vi.fn();
    const res = await handleDecide(body, deps(fetchMock, { keyMode: 'dev', log }));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(JSON.parse(init.body as string).model).toBe('jev-1.13.0');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer ts-key');
    expect(headers['X-Opper-Name']).toBeUndefined();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ answers, costEstimated: true, traceId: 'req_1' });
    expect((res.body as { costUsd: number }).costUsd).toBeCloseTo(0.000042, 9);
    expect(log.mock.calls[0][0]).toMatch(/^\[jev dev typesafe\] blinky ok in \d+ ms, cost ≈0\.000042 USD, request req_1$/);
  });

  it('reports TypeSafe errors without the key', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ error: 'bad key ts-key' }), { status: 401 }));
    const res = await handleDecide(body, deps(fetchMock, { keyMode: 'dev' }));
    expect(res).toEqual({ status: 502, body: { error: 'jev returned HTTP 401: bad key [redacted]' } });
  });

  it('keeps the Opper behaviour by default', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ answers, usage: { input_tokens: 5, output_tokens: 2 } }), { status: 200, headers: { 'x-opper-cost': '0.00002' } }));
    const res = await handleDecide(body, deps(fetchMock, { provider: undefined, baseUrl: 'https://api.opper.ai' }));
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.opper.ai/v3/compat/v1/systemone');
    expect(res.body).toMatchObject({ costUsd: 0.00002 });
    expect((res.body as Record<string, unknown>).costEstimated).toBeUndefined();
  });
});
