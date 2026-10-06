import { describe, expect, it } from 'vitest';
import { isClassic, OTHER_GAMES, WATCH } from '../src/overlay';

describe('the Play card', () => {
  it('puts watching a model against the classic ghosts first, and offers the other three games below', () => {
    expect(WATCH).toEqual({ pacman: 'ai', ghosts: 'classic' });
    expect(OTHER_GAMES.map((g) => g.title)).toEqual(['Beat the AI', 'Play against AI ghosts', 'AI vs AI']);
    const all = [WATCH, ...OTHER_GAMES.map((g) => g.sides)].map((s) => `${s.pacman}/${s.ghosts}`);
    expect(new Set(all).size).toBe(4);
  });

  it('counts only you against the classic ghosts as the free, leaderboard game', () => {
    expect(isClassic({ pacman: 'you', ghosts: 'classic' })).toBe(true);
    expect(isClassic(WATCH)).toBe(false);
    expect(isClassic({ pacman: 'you', ghosts: 'ai' })).toBe(false);
  });
});
