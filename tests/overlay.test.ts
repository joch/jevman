import { describe, expect, it } from 'vitest';
import { chipsPick, isClassic, OTHER_GAMES, titleFor, WATCH } from '../src/overlay';

describe('the Play card', () => {
  it('puts watching a model against the classic ghosts first, and offers the other three games below', () => {
    expect(titleFor(WATCH)).toBe('Watch an AI play');
    expect(OTHER_GAMES.map((g) => titleFor(g.sides))).toEqual(['Beat the AI', 'Play against an AI', 'AI vs AI']);
    const all = [WATCH, ...OTHER_GAMES.map((g) => g.sides)].map((s) => `${s.pacman}/${s.ghosts}`);
    expect(new Set(all).size).toBe(4);
  });

  it('lets the model chips pick the AI of each game', () => {
    expect(chipsPick(WATCH)).toBe('pacman');
    expect(chipsPick({ pacman: 'ai', ghosts: 'ai' })).toBe('pacman');
    expect(chipsPick({ pacman: 'you', ghosts: 'ai' })).toBe('ghosts');
    expect(chipsPick({ pacman: 'you', ghosts: 'classic' })).toBeNull();
  });

  it('counts only you against the classic ghosts as the free, leaderboard game', () => {
    expect(isClassic({ pacman: 'you', ghosts: 'classic' })).toBe(true);
    expect(isClassic(WATCH)).toBe(false);
  });
});
