import { describe, expect, it } from 'vitest';
import { leaderboardRows } from '../src/leaderboard-view';
import type { Leaderboard, LeaderboardEntry } from '../shared/leaderboard';

const entry = (over: Partial<LeaderboardEntry>): LeaderboardEntry => ({
  model: 'typesafe/jev-1.13.0', name: 'jev 1.13', games: 8, meanScore: 2000, meanSurvivedSeconds: 50, meanPellets: 180, pelletsPerLife: 60,
  meanGhostsEaten: 1, fruitEaten: '5/8', bestLevel: 1, fallbackRate: 0.04, meanLatencyMs: 250, costPerGame: 0.005, deathsBy: {}, ...over,
});
const board = (entries: LeaderboardEntry[]): Leaderboard => ({ generatedAt: '2026-10-05T18:00:00Z', settings: { gamesPerModel: 8, maxSeconds: 300, safetyCheck: false, ghosts: 'scripted' }, entries, skipped: [] });

describe('leaderboardRows', () => {
  it('ranks, scales the score bars to the best model and names each category winner', () => {
    const rows = leaderboardRows(board([
      entry({ model: 'opper/clef', name: 'Clef', meanScore: 3200, costPerGame: 0.02, meanLatencyMs: 300, meanSurvivedSeconds: 54 }),
      entry({ meanScore: 2800, meanSurvivedSeconds: 57 }),
      entry({ model: 'berget/convaiinnovations/laya', name: 'Laya', meanScore: 600, meanLatencyMs: 95, costPerGame: 0.004 }),
    ]));
    expect(rows.map((r) => [r.rank, r.name, r.barPercent])).toEqual([[1, 'Clef', 100], [2, 'jev 1.13', 88], [3, 'Laya', 19]]);
    expect(rows[0].badges).toContain('Most points');
    expect(rows[1].badges).toContain('Survives longest');
    expect(rows[2].badges).toEqual(['Fastest', 'Cheapest']);
    expect(rows[0].stats).toContainEqual(['Cost per game', '$0.020']);
    expect(rows[0].maker).toBe('Cloudflare');
    expect(rows[0].playUrl).toBe('/?pacman=opper%2Fclef');
    expect(rows[0].scoreLabel).toBe('3,200 points');
  });

  it('calls a lead within the margin of error a joint top score', () => {
    const rows = leaderboardRows(board([
      entry({ model: 'typesafe/jev-1.13.0', meanScore: 3181, scoreStdError: 186 }),
      entry({ model: 'opper/clef', name: 'Clef', meanScore: 3038, scoreStdError: 125 }),
      entry({ model: 'opper/kev-4b', name: 'Kev 4B', meanScore: 1445, scoreStdError: 22 }),
    ]));
    expect(rows.map((r) => r.badges.includes('Joint top score'))).toEqual([true, true, false]);
    expect(rows.flatMap((r) => r.badges)).not.toContain('Most points');
    expect(rows[0].scoreLabel).toBe('3,181 points ± 372');
  });

  it('copes with an empty board', () => {
    expect(leaderboardRows(board([]))).toEqual([]);
  });
});
