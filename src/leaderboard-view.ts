import { DECISION_MODELS } from '../shared/models';
import type { Leaderboard, LeaderboardEntry } from '../shared/leaderboard';

export interface LeaderboardRow {
  rank: number;
  model: string;
  name: string;
  maker: string;
  score: number;
  /** Width of the score bar, relative to the best model. */
  barPercent: number;
  badges: string[];
  stats: [string, string][];
  /** Opens the game with this model playing Pac-Man. */
  playUrl: string;
}

const best = (entries: LeaderboardEntry[], value: (e: LeaderboardEntry) => number | null, lowest = false) => {
  const scored = entries.filter((e) => value(e) !== null);
  if (!scored.length) return undefined;
  return scored.reduce((a, b) => ((lowest ? value(b)! < value(a)! : value(b)! > value(a)!) ? b : a)).model;
};

export function leaderboardRows(board: Leaderboard): LeaderboardRow[] {
  const entries = board.entries;
  const top = Math.max(1, ...entries.map((e) => e.meanScore));
  const winners: [string, string | undefined][] = [
    ['Most points', best(entries, (e) => e.meanScore)],
    ['Survives longest', best(entries, (e) => e.meanSurvivedSeconds)],
    ['Fastest', best(entries, (e) => e.meanLatencyMs, true)],
    ['Cheapest', best(entries, (e) => e.costPerGame, true)],
  ];
  return entries.map((e, i) => ({
    rank: i + 1,
    model: e.model,
    name: e.name,
    maker: DECISION_MODELS.find((m) => m.id === e.model)?.maker ?? '',
    score: e.meanScore,
    barPercent: Math.round((e.meanScore / top) * 100),
    badges: winners.filter(([, m]) => m === e.model).map(([label]) => label),
    stats: [
      ['Survived', `${Math.round(e.meanSurvivedSeconds)} s`],
      ['Pellets per life', String(e.pelletsPerLife)],
      ['Ghosts eaten', String(e.meanGhostsEaten)],
      ['Fruit', e.fruitEaten],
      ['Fallbacks', `${(e.fallbackRate * 100).toFixed(1)}%`],
      ['Latency', e.meanLatencyMs === null ? '–' : `${e.meanLatencyMs} ms`],
      ['Cost per game', `$${e.costPerGame.toFixed(3)}`],
    ],
    playUrl: `/?pacman=${encodeURIComponent(e.model)}`,
  }));
}
