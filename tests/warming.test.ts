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

  it('tries twice, then reports a model that would not wake, so the game does not start on it', async () => {
    const { pending, warming } = setup();
    const done = warming.warmAll(() => ['opper/clef'], () => {});
    pending[0].resolve(false);
    await flush();
    expect(pending).toHaveLength(2); // second attempt
    pending[1].resolve(false);
    expect(await done).toEqual(['opper/clef']);
    expect(warming.isWarm('opper/clef')).toBe(false);
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
    expect(await done).toEqual([]);
    expect(waits).toEqual([['opper/clef'], ['opper/kev-4b']]);
  });
});

it('ignores a failure of a model the player has since swapped out', async () => {
  const { pending, warming } = setup();
  let models = ['opper/clef'];
  const done = warming.warmAll(() => models, () => {});
  models = ['typesafe/jev-1.13.0'];
  pending[0].resolve(false);
  await flush();
  pending[1].resolve(false); // Clef's second attempt fails too, but nobody wants Clef now
  await flush();
  expect(pending.at(-1)!.model).toBe('typesafe/jev-1.13.0');
  pending.at(-1)!.resolve(true);
  expect(await done).toEqual([]);
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
