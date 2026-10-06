import { describe, expect, it } from 'vitest';
import { gamePitch, isClassic } from '../src/overlay';

describe('the Play card', () => {
  it('pitches the game each choice of sides makes', () => {
    expect(gamePitch({ pacman: 'you', ghosts: 'classic' }, 'jev 1.13', 'Clef')).toMatchObject({ title: 'Beat the AI', line: expect.stringMatching(/Free\.$/) });
    expect(gamePitch({ pacman: 'ai', ghosts: 'classic' }, 'jev 1.13', 'Clef')).toEqual({ title: 'Watch the AI play', line: 'jev 1.13 plays Pac-Man against the classic ghosts.' });
    expect(gamePitch({ pacman: 'you', ghosts: 'ai' }, 'jev 1.13', 'Clef')).toMatchObject({ title: 'Play against the AI', line: expect.stringMatching(/Clef plays the four ghosts/) });
    expect(gamePitch({ pacman: 'ai', ghosts: 'ai' }, 'jev 1.13', 'Clef')).toEqual({ title: 'AI vs AI', line: "jev 1.13 as Pac-Man against Clef's ghosts. Who wins?" });
    expect(gamePitch({ pacman: 'ai', ghosts: 'ai' }, 'Clef', 'Clef').line).toMatch(/plays both sides/);
  });

  it('counts only you against the classic ghosts as the free, leaderboard game', () => {
    expect(isClassic({ pacman: 'you', ghosts: 'classic' })).toBe(true);
    expect(isClassic({ pacman: 'ai', ghosts: 'classic' })).toBe(false);
    expect(isClassic({ pacman: 'you', ghosts: 'ai' })).toBe(false);
  });
});
