import { describe, expect, it } from 'vitest';
import { shareText, versus, versusLine } from '../src/versus';
import type { Leaderboard } from '../shared/leaderboard';

const board = {
  generatedAt: '', settings: { gamesPerModel: 24, maxSeconds: 300, ghosts: 'scripted' }, skipped: [],
  entries: [['jev 1.13', 3181], ['Clef', 3038], ['Clef Flash', 2679], ['Kev 4B', 1445], ['Laya', 650]].map(([name, meanScore]) => ({ name, meanScore })),
} as unknown as Leaderboard;

describe('versus the AIs', () => {
  it('splits the models into beaten and still ahead', () => {
    const v = versus(board, 2900);
    expect(v).toEqual({ score: 2900, beaten: ['Clef Flash', 'Kev 4B', 'Laya'], ahead: ['jev 1.13', 'Clef'], total: 5 });
    expect(versusLine(v)).toBe('You beat Clef Flash, Kev 4B and Laya. jev 1.13 and Clef still beat you.');
  });

  it('celebrates beating them all and encourages beating none', () => {
    expect(versusLine(versus(board, 5000))).toBe('You beat every AI on the leaderboard! 🏆');
    expect(versusLine(versus(board, 400))).toBe('No AI beaten yet: even Laya scores more on average. Try again!');
    expect(versusLine(versus(board, 3100))).toBe('You beat Clef, Clef Flash, Kev 4B and Laya. jev 1.13 still beats you.');
  });

  it('writes a short share text with the link', () => {
    expect(shareText(versus(board, 2900), 'https://jevman.apps.chadda.se')).toBe(
      'I scored 2,900 at jevman 🟡 and beat 3 of 5 AIs at Pac-Man\n✅ Clef Flash · Kev 4B · Laya\n❌ jev 1.13 · Clef\nCan you beat the AI? https://jevman.apps.chadda.se',
    );
  });
});
