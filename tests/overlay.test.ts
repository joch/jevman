import { describe, expect, it } from 'vitest';
import { gameLine, isClassic } from '../src/overlay';

describe('the Play card', () => {
  it('describes the game each choice of sides makes', () => {
    expect(gameLine({ pacman: 'you', ghosts: 'classic' }, 'jev 1.13', 'Clef')).toMatch(/^You against the classic ghosts.*Free\.$/);
    expect(gameLine({ pacman: 'ai', ghosts: 'classic' }, 'jev 1.13', 'Clef')).toBe('Watch jev 1.13 play Pac-Man against the classic ghosts.');
    expect(gameLine({ pacman: 'you', ghosts: 'ai' }, 'jev 1.13', 'Clef')).toMatch(/against Clef's ghosts/);
    expect(gameLine({ pacman: 'ai', ghosts: 'ai' }, 'jev 1.13', 'Clef')).toBe('jev 1.13 plays Pac-Man, Clef plays the ghosts.');
    expect(gameLine({ pacman: 'ai', ghosts: 'ai' }, 'Clef', 'Clef')).toBe('Clef plays both sides: Pac-Man and the ghosts.');
  });

  it('counts only you against the classic ghosts as the free, leaderboard game', () => {
    expect(isClassic({ pacman: 'you', ghosts: 'classic' })).toBe(true);
    expect(isClassic({ pacman: 'ai', ghosts: 'classic' })).toBe(false);
    expect(isClassic({ pacman: 'you', ghosts: 'ai' })).toBe(false);
  });
});
