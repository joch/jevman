import { describe, expect, it } from 'vitest';
import { GAMES, isClassic } from '../src/overlay';

describe('the Play card', () => {
  it('offers the four games, each a different choice of who plays each side', () => {
    expect(GAMES.map((g) => g.title)).toEqual(['Watch the AI play', 'Play against the AI', 'Beat the AI', 'AI vs AI']);
    expect(new Set(GAMES.map((g) => `${g.sides.pacman}/${g.sides.ghosts}`)).size).toBe(4);
    expect(GAMES.find((g) => g.title === 'Beat the AI')!.sides).toEqual({ pacman: 'you', ghosts: 'classic' });
  });

  it('counts only you against the classic ghosts as the free, leaderboard game', () => {
    expect(isClassic({ pacman: 'you', ghosts: 'classic' })).toBe(true);
    expect(isClassic({ pacman: 'ai', ghosts: 'classic' })).toBe(false);
    expect(isClassic({ pacman: 'you', ghosts: 'ai' })).toBe(false);
  });
});
