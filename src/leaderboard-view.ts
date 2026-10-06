import { DECISION_MODELS } from '../shared/models';
import { jointLeaders, type CommunityEntry, type Leaderboard, type LeaderboardEntry } from '../shared/leaderboard';

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
  /** Ours: opens the game with this model playing Pac-Man. Self-reported: the submitter's page, if any. */
  link: { href: string; label: string } | null;
}

const best = (entries: LeaderboardEntry[], value: (e: LeaderboardEntry) => number | null, lowest = false) => {
  const scored = entries.filter((e) => value(e) !== null);
  if (!scored.length) return undefined;
  return scored.reduce((a, b) => ((lowest ? value(b)! < value(a)! : value(b)! > value(a)!) ? b : a)).model;
};

const scoreLabel = (e: LeaderboardEntry) =>
  `${e.meanScore.toLocaleString('en-US')} points${e.scoreStdError ? ` ± ${Math.round(2 * e.scoreStdError).toLocaleString('en-US')}` : ''}`;

const statsOf = (e: LeaderboardEntry): [string, string][] => [
  ['Survived', `${Math.round(e.meanSurvivedSeconds)} s`],
  ['Pellets per life', String(e.pelletsPerLife)],
  ['Ghosts eaten', String(e.meanGhostsEaten)],
  ['Fruit', e.fruitEaten],
  ['Fallbacks', `${(e.fallbackRate * 100).toFixed(1)}%`],
  ['Latency', e.meanLatencyMs === null ? '–' : `${e.meanLatencyMs} ms`],
  ['Cost per game', `$${e.costPerGame.toFixed(3)}`],
];

/** The bars of both lists share one scale: the best score on either. */
export const topScore = (...lists: LeaderboardEntry[][]): number => Math.max(1, ...lists.flat().map((e) => e.meanScore));

export function leaderboardRows(board: Leaderboard, top = topScore(board.entries)): LeaderboardRow[] {
  const entries = board.entries;
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
    scoreLabel: scoreLabel(e),
    barPercent: Math.round((e.meanScore / top) * 100),
    badges: winners.filter(([, m]) => m === e.model).map(([label]) => label),
    stats: statsOf(e),
    link: { href: `/?pacman=${encodeURIComponent(e.model)}`, label: `Watch ${e.name} play →` },
  }));
}

/** Models their makers benchmarked and submitted: ranked among themselves, every one marked self-reported. */
export function communityRows(entries: CommunityEntry[], top = topScore(entries)): LeaderboardRow[] {
  return entries.map((e, i) => ({
    rank: i + 1,
    model: e.model,
    name: e.name,
    maker: `submitted by @${e.by}`,
    score: e.meanScore,
    scoreLabel: scoreLabel(e),
    barPercent: Math.round((e.meanScore / top) * 100),
    badges: ['Self-reported'],
    stats: statsOf(e),
    link: e.url ? { href: e.url, label: `About ${e.name} ↗` } : null,
  }));
}
