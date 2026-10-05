import { DECISION_MODELS } from '../shared/models';
import { jointLeaders, type Leaderboard, type LeaderboardEntry } from '../shared/leaderboard';

export interface LeaderboardRow {
  rank: number;
  model: string;
  name: string;
  maker: string;
  score: number;
  /** e.g. "3,181 points ± 365": the mean and its margin of error (two standard errors). */
  scoreLabel: string;
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
  // A lead within the margin of error is a tie, not a win.
  const tied = jointLeaders(entries);
  const winners: [string, string | undefined][] = [
    ...(tied.length ? tied.map((e): [string, string] => ['Joint top score', e.model]) : [['Most points', best(entries, (e) => e.meanScore)] as [string, string | undefined]]),
    ['Survives longest', best(entries, (e) => e.meanSurvivedSeconds)],
    ['Fastest', best(entries, (e) => e.meanLatencyMs, true)],
    ['Cheapest', best(entries, (e) => e.costPerGame, true)],
  ];
  return entries.map((e, i) => ({
    // Joint leaders share first place; the next model is third.
    rank: tied.includes(e) ? 1 : i + 1,
    model: e.model,
    name: e.name,
    maker: DECISION_MODELS.find((m) => m.id === e.model)?.maker ?? '',
    score: e.meanScore,
    scoreLabel: `${e.meanScore.toLocaleString('en-US')} points${e.scoreStdError ? ` ± ${Math.round(2 * e.scoreStdError).toLocaleString('en-US')}` : ''}`,
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
