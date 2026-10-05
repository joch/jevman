import { describe, expect, it } from 'vitest';
import { rank, summarize, type GameResult } from '../shared/leaderboard';

const game = (over: Partial<GameResult>): GameResult => ({
  survived: 60, score: 2000, pellets: 200, deaths: 3, level: 1, calls: 100, decisions: 90, fallbacks: 0, overrides: 0,
  latencyMsSum: 25_000, cost: 0.005, fruitSpawned: 2, fruitEaten: 1, ghostsEaten: 2, deathsBy: { 'at/near junction': 3 }, ...over,
});

describe('leaderboard', () => {
  it('summarizes a model over its games', () => {
    const e = summarize('opper/kev-4b', [game({ score: 1000, fallbacks: 9 }), game({ score: 3000, level: 2, deaths: 2, deathsBy: { 'ghost from behind': 2 } })]);
    expect(e).toMatchObject({
      model: 'opper/kev-4b', name: 'Kev 4B', games: 2, meanScore: 2000, meanSurvivedSeconds: 60, pelletsPerLife: 80,
      fruitEaten: '2/4', bestLevel: 2, fallbackRate: 0.05, meanLatencyMs: 250, costPerGame: 0.005,
      deathsBy: { 'at/near junction': 3, 'ghost from behind': 2 },
    });
  });

  it('ranks by mean score, best first', () => {
    const a = summarize('opper/clef', [game({ score: 1500 })]);
    const b = summarize('typesafe/jev-1.13.0', [game({ score: 2500 })]);
    expect(rank([a, b]).map((e) => e.model)).toEqual(['typesafe/jev-1.13.0', 'opper/clef']);
  });

  it('reports no latency for a model that never answered', () => {
    expect(summarize('berget/convaiinnovations/laya', [game({ calls: 0, latencyMsSum: 0 })]).meanLatencyMs).toBeNull();
  });
});
