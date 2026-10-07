import { describe, expect, it } from 'vitest';
import { communityRows, leaderboardRows, topScore, verdict } from '../src/leaderboard-view';
import type { CommunityEntry, Leaderboard, LeaderboardEntry } from '../shared/leaderboard';

const entry = (over: Partial<LeaderboardEntry>): LeaderboardEntry => ({
  model: 'typesafe/jev-1.13.0', name: 'jev 1.13', games: 8, meanScore: 2000, meanSurvivedSeconds: 50, meanPellets: 180, pelletsPerLife: 60,
  meanGhostsEaten: 1, fruitEaten: '5/8', bestLevel: 1, fallbackRate: 0.04, meanLatencyMs: 250, costPerGame: 0.005, deathsBy: {}, ...over,
});
const board = (entries: LeaderboardEntry[]): Leaderboard => ({ generatedAt: '2026-10-05T18:00:00Z', settings: { gamesPerModel: 8, maxSeconds: 300, ghosts: 'scripted' }, entries, skipped: [] });

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
    expect(rows[0].summary).toBe('Survives 54 s · thinks in 0.30 s · $0.020 a game');
    expect(rows[0].stats).toContainEqual(['Backup-rule moves', '4.0%']);
    expect(rows[0].maker).toBe('Cloudflare');
    expect(rows[0].link).toEqual({ href: '/?pacman=opper%2Fclef', label: 'Watch it play →' });
    expect(rows[0].scoreLabel).toBe('3,200 points');
  });

  it('calls a lead within the margin of error a joint top score', () => {
    const rows = leaderboardRows(board([
      entry({ model: 'typesafe/jev-1.13.0', meanScore: 3181, scoreStdError: 186 }),
      entry({ model: 'opper/clef', name: 'Clef', meanScore: 3038, scoreStdError: 125 }),
      entry({ model: 'opper/kev-4b', name: 'Kev 4B', meanScore: 1445, scoreStdError: 22 }),
    ]));
    expect(rows.map((r) => r.badges.includes('Joint top score'))).toEqual([true, true, false]);
    expect(rows.map((r) => r.rank)).toEqual([1, 1, 3]);
    expect(rows.flatMap((r) => r.badges)).not.toContain('Most points');
    expect(rows[0].scoreLabel).toBe('3,181 points ± 372');
  });

  it('counts every model within the margin of error of the leader as joint top', () => {
    const rows = leaderboardRows(board([
      entry({ model: 'typesafe/jev-1.13.0', meanScore: 3000, scoreStdError: 200 }),
      entry({ model: 'opper/clef', name: 'Clef', meanScore: 2900, scoreStdError: 200 }),
      entry({ model: 'opper/clef-flash', name: 'Clef Flash', meanScore: 2700, scoreStdError: 200 }),
      entry({ model: 'opper/kev-4b', name: 'Kev 4B', meanScore: 1400, scoreStdError: 30 }),
    ]));
    expect(rows.map((r) => r.rank)).toEqual([1, 1, 1, 4]);
    expect(rows.map((r) => r.badges.includes('Joint top score'))).toEqual([true, true, true, false]);
  });

  it('finds a high-variance model tied with the leader even below a model that is not', () => {
    const rows = leaderboardRows(board([
      entry({ model: 'typesafe/jev-1.13.0', meanScore: 3000, scoreStdError: 50 }),
      entry({ model: 'opper/clef', name: 'Clef', meanScore: 2800, scoreStdError: 40 }),
      entry({ model: 'opper/clef-flash', name: 'Clef Flash', meanScore: 2700, scoreStdError: 400 }),
    ]));
    expect(rows.map((r) => r.rank)).toEqual([1, 2, 1]);
    expect(rows[2].badges).toContain('Joint top score');
  });

  it('copes with an empty board', () => {
    expect(leaderboardRows(board([]))).toEqual([]);
  });
});

describe('communityRows', () => {
  const submitted = (over: Partial<CommunityEntry>): CommunityEntry => ({ ...entry({}), model: 'acme-pac', name: 'Acme Pac', by: 'acme', selfReported: true, ...over });

  it('marks every entry self-reported, credits the submitter and scales its bars with our models', () => {
    const ours = [entry({ meanScore: 3000 })];
    const rows = communityRows([submitted({ meanScore: 1500, url: 'https://acme.example/pac' }), submitted({ model: 'other', name: 'Other', meanScore: 900, url: undefined })], topScore(ours, []));
    expect(rows.map((r) => [r.rank, r.name, r.barPercent, r.badges])).toEqual([
      [1, 'Acme Pac', 50, ['Self-reported']],
      [2, 'Other', 30, ['Self-reported']],
    ]);
    expect(rows[0].maker).toBe('submitted by @acme');
    expect(rows[0].link).toEqual({ href: 'https://acme.example/pac', label: 'About Acme Pac ↗' });
    expect(rows[1].link).toBeNull();
  });
});

describe('verdict', () => {
  it('names the winner and the lead, or calls a tie', () => {
    expect(verdict(board([entry({ name: 'jev 1.13', meanScore: 3000, scoreStdError: 50 }), entry({ model: 'opper/clef', name: 'Clef', meanScore: 2500, scoreStdError: 50 })]))).toBe('jev 1.13 plays best, 500 points ahead of Clef on average.');
    expect(verdict(board([entry({ name: 'jev 1.13', meanScore: 3000, scoreStdError: 300 }), entry({ model: 'opper/clef', name: 'Clef', meanScore: 2900, scoreStdError: 300 })]))).toBe('jev 1.13 and Clef share the top spot: their scores are too close to call.');
  });
});
