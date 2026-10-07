import { describe, expect, it, vi } from 'vitest';
import { DECISION_MODELS, DEFAULT_MODEL, isModelId, modelName } from '../shared/models';
import { handleDecide, type DecideDeps } from '../server/decide';
import { modelFor, requestedModelFor } from '../server/jev';

const body = { state: { maze: ['#'] }, questions: { blinky: { type: 'choice', instructions: 'chase', criteria: { left: 'a', up: 'b' } } } };
const answers = { blinky: { type: 'choice', choice: 'up', confidence: 0.9, probabilities: { up: 0.9, left: 0.1 } } };
const ok = () =>
  vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ answers, usage: { input_tokens: 5, output_tokens: 2 } }), { status: 200, headers: { 'x-opper-cost': '0.00002' } }));
const deps = (fetchImpl: DecideDeps['fetch'], over: Partial<DecideDeps> = {}): DecideDeps => ({ apiKey: 'k', baseUrl: 'https://api.opper.ai', fetch: fetchImpl, now: () => 0, ...over });
const sentModel = (f: ReturnType<typeof ok>) => JSON.parse((f.mock.calls[0][1] as RequestInit).body as string).model;

describe('decision models', () => {
  it('lists the System One models Opper serves, jev first and default', () => {
    expect(DECISION_MODELS.map((m) => m.id)).toEqual(['typesafe/jev-1.13.0', 'opper/clef', 'opper/clef-flash', 'opper/kev-4b', 'berget/convaiinnovations/laya', 'openai/gpt-6-luna-decisions']);
    expect(DEFAULT_MODEL).toBe('typesafe/jev-1.13.0');
    expect(isModelId('opper/kev-4b')).toBe(true);
    expect(isModelId('openai/gpt-5')).toBe(false);
    expect(modelName('opper/clef-flash')).toBe('Clef Flash');
  });

  it('maps a model to the id each provider expects; TypeSafe only serves jev', () => {
    expect(requestedModelFor('opper', 'opper/kev-4b')).toBe('opper/kev-4b');
    expect(requestedModelFor('typesafe', 'typesafe/jev-1.13.0')).toBe('jev-1.13.0');
    expect(requestedModelFor('typesafe', 'opper/kev-4b')).toBeNull();
    expect(modelFor('opper', {})).toBe('typesafe/jev-1.13.0');
  });
});

describe('handleDecide with a model', () => {
  it('sends the requested model, defaulting to jev', async () => {
    const f1 = ok();
    await handleDecide({ ...body, model: 'opper/clef' }, deps(f1));
    expect(sentModel(f1)).toBe('opper/clef');
    const f2 = ok();
    await handleDecide(body, deps(f2));
    expect(sentModel(f2)).toBe('typesafe/jev-1.13.0');
  });

  it('uses JEV_MODEL when the request names no model, and still checks a named one against the list', async () => {
    vi.stubEnv('JEV_MODEL', 'opper/kev-4b');
    try {
      const f = ok();
      const res = await handleDecide(body, deps(f));
      expect(sentModel(f)).toBe('opper/kev-4b');
      expect((res.body as { model: string }).model).toBe('opper/kev-4b');
      const named = ok();
      await handleDecide({ ...body, model: 'opper/clef' }, deps(named));
      expect(sentModel(named)).toBe('opper/clef');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('refuses models outside the list, and non-jev models on a TypeSafe key', async () => {
    const f = ok();
    expect((await handleDecide({ ...body, model: 'openai/gpt-5' }, deps(f))).status).toBe(400);
    expect((await handleDecide({ ...body, model: { toString: 1 } }, deps(f))).status).toBe(400);
    expect((await handleDecide({ ...body, model: '__proto__' }, deps(f))).status).toBe(400);
    const ts = await handleDecide({ ...body, model: 'opper/kev-4b' }, deps(f, { provider: 'typesafe', baseUrl: 'https://api.typesafe.ai' }));
    expect(ts.status).toBe(400);
    expect((ts.body as { error: string }).error).toMatch(/TypeSafe key only/);
    expect(f).not.toHaveBeenCalled();
  });
});
