import { describe, expect, it } from 'vitest';
import { arrowsFor } from '../src/thinking';
import type { Decision } from '../src/brain';

const d = (over: Partial<Decision>): Decision => ({ actor: 'pacman', key: 'k', tile: { x: 1, y: 1 }, choice: 'left', options: ['left', 'up', 'down'], probabilities: { left: 0.6, up: 0.3, down: 0.1 }, confidence: 0.5, source: 'jev', ...over });

describe('arrowsFor', () => {
  it('draws one arrow per option, sized by the odds, marking the pick', () => {
    expect(arrowsFor(d({}))).toEqual([
      { dir: 'left', p: 0.6, chosen: true },
      { dir: 'up', p: 0.3, chosen: false },
      { dir: 'down', p: 0.1, chosen: false },
    ]);
  });
});
