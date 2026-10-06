// What a benchmark game and a replayed submission share: the scripted rule for the actors no model plays, and how a
// finished game becomes a GameResult.
import { greedyChoice, optionFeatures } from '../src/features';
import type { Controls, GameState } from '../src/sim';
import type { GameStats } from '../src/stats';
import type { GameResult } from '../shared/leaderboard';

/** The classic rule for every actor no model plays: greedy, and like the scheduler, each escape question answered once. */
export function scriptedControls(): Controls {
  const answeredEscapes = new Set<string>();
  return {
    decide: (point, s) => {
      if (point.escape) {
        if (answeredEscapes.has(point.key)) return null;
        answeredEscapes.add(point.key);
      }
      return greedyChoice(s, point, optionFeatures(s, point));
    },
  };
}

export const emptyResult = (): GameResult => ({
  survived: 0,
  score: 0,
  pellets: 0,
  deaths: 0,
  level: 1,
  calls: 0,
  decisions: 0,
  fallbacks: 0,
  latencyMsSum: 0,
  cost: 0,
  fruitSpawned: 0,
  fruitEaten: 0,
  ghostsEaten: 0,
  deathsBy: {},
});

/** Fills in what GameStats counted, once the game is over. */
export function finishResult(r: GameResult, stats: GameStats, state: GameState): GameResult {
  const summary = stats.summary(state);
  Object.assign(r, {
    score: state.score,
    level: state.level,
    pellets: summary.pellets,
    deaths: summary.deaths.length,
    decisions: summary.jev.decisions,
    fallbacks: summary.jev.fallbacks,
    fruitEaten: summary.fruit.length,
    ghostsEaten: summary.ghostsEaten,
  });
  for (const d of summary.deaths) r.deathsBy[d.context] = (r.deathsBy[d.context] ?? 0) + 1;
  return r;
}
