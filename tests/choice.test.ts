import { describe, expect, it } from 'vitest';
import { initialChoice, modelOptions, requestModel, setGhosts } from '../src/choice';

const all = ['typesafe/jev-1.13.0', 'opper/clef', 'opper/clef-flash', 'opper/kev-4b', 'berget/convaiinnovations/laya', 'openai/gpt-6-luna-decisions'];

describe('model choice', () => {
  it('offers the models the key can use, plus an unlisted server default', () => {
    expect(modelOptions({ defaultModel: 'typesafe/jev-1.13.0', models: all }).map((o) => o.label)).toEqual(['jev 1.13', 'Clef', 'Clef Flash', 'Kev 4B', 'Laya', 'GPT-6 Luna']);
    expect(modelOptions({ defaultModel: 'acme/zed', models: ['typesafe/jev-1.13.0'] })).toEqual([
      { id: 'acme/zed', label: 'acme/zed (server default)' },
      { id: 'typesafe/jev-1.13.0', label: 'jev 1.13' },
    ]);
  });

  it('starts from the server default and keeps only stored picks that are still offered', () => {
    const me = { defaultModel: 'typesafe/jev-1.13.0', models: all };
    expect(initialChoice(me, null)).toEqual({ pacman: 'typesafe/jev-1.13.0', blinky: 'typesafe/jev-1.13.0', pinky: 'typesafe/jev-1.13.0', inky: 'typesafe/jev-1.13.0', clyde: 'typesafe/jev-1.13.0' });
    const stored = { pacman: 'opper/clef', blinky: 'openai/gpt-5', inky: 42 };
    expect(initialChoice(me, stored)).toMatchObject({ pacman: 'opper/clef', blinky: 'typesafe/jev-1.13.0', inky: 'typesafe/jev-1.13.0' });
    // A TypeSafe key only offers jev, so a stored Clef falls back.
    expect(initialChoice({ defaultModel: 'typesafe/jev-1.13.0', models: ['typesafe/jev-1.13.0'] }, stored).pacman).toBe('typesafe/jev-1.13.0');
  });

  it('names a model in requests only when it differs from the server default', () => {
    const c = setGhosts(initialChoice({ defaultModel: 'typesafe/jev-1.13.0', models: all }, null), 'opper/kev-4b');
    expect(requestModel(c, 'pacman', 'typesafe/jev-1.13.0')).toBeUndefined();
    expect(requestModel(c, 'clyde', 'typesafe/jev-1.13.0')).toBe('opper/kev-4b');
  });
});
