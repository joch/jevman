import { describe, expect, it } from 'vitest';
import { AWAKE_MS, effectiveChoice, ModelWarming } from '../src/warming';
import type { ModelChoice } from '../src/choice';

function setup() {
  const clock = { now: 0 };
  const pending: { model: string; resolve: (ok: boolean) => void }[] = [];
  const warming = new ModelWarming({ now: () => clock.now, warmUp: (model) => new Promise((resolve) => pending.push({ model, resolve })) });
  return { clock, pending, warming };
}
const flush = () => new Promise((r) => setTimeout(r, 0));
const all = (m: string): ModelChoice => ({ pacman: m, blinky: m, pinky: m, inky: m, clyde: m });

describe('ModelWarming', () => {
  it('sends one warm-up per model at a time and counts it awake until AWAKE_MS after it answered', async () => {
    const { clock, pending, warming } = setup();
    void warming.warm('opper/clef');
    void warming.warm('opper/clef');
    expect(pending.map((p) => p.model)).toEqual(['opper/clef']);
    expect(warming.isWarm('opper/clef')).toBe(false);
    clock.now = 4000;
    pending[0].resolve(true);
    await flush();
    expect(warming.isWarm('opper/clef')).toBe(true);
    clock.now = 4000 + AWAKE_MS;
    expect(warming.isWarm('opper/clef')).toBe(false);
  });

  it('keeps a playing model awake from its game calls, without new warm-ups', async () => {
    const { clock, pending, warming } = setup();
    warming.touch('opper/kev-4b');
    clock.now = AWAKE_MS - 1;
    await warming.warm('opper/kev-4b');
    expect(pending).toHaveLength(0);
  });

  it('lets a model that failed to wake play anyway', async () => {
    const { pending, warming } = setup();
    const done = warming.warm('opper/clef');
    pending[0].resolve(false);
    expect(await done).toBe(false);
    expect(warming.isWarm('opper/clef')).toBe(true);
  });

  it('waits for models picked while it was already waiting', async () => {
    const { pending, warming } = setup();
    let models = ['opper/clef'];
    const waits: string[][] = [];
    const done = warming.warmAll(() => models, (cold) => waits.push(cold));
    models = ['opper/kev-4b']; // picked during "Waking up Clef…"
    pending[0].resolve(true);
    await flush();
    expect(pending.map((p) => p.model)).toEqual(['opper/clef', 'opper/kev-4b']);
    pending[1].resolve(true);
    await done;
    expect(waits).toEqual([['opper/clef'], ['opper/kev-4b']]);
  });
});

describe('effectiveChoice', () => {
  it('keeps the playing model until the picked one is awake, else falls back to the default', () => {
    const warm = new Set(['typesafe/jev-1.13.0', 'opper/clef']);
    const isWarm = (m: string) => warm.has(m);
    const current = all('opper/clef');
    const wanted = { ...all('opper/kev-4b'), pinky: 'typesafe/jev-1.13.0' };
    expect(effectiveChoice(wanted, current, isWarm, 'typesafe/jev-1.13.0')).toEqual({ ...all('opper/clef'), pinky: 'typesafe/jev-1.13.0' });
    expect(effectiveChoice(wanted, all('opper/clef-flash'), isWarm, 'typesafe/jev-1.13.0').blinky).toBe('typesafe/jev-1.13.0');
  });
});
