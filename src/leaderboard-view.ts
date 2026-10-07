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
  /** The plain one-liner under the bar: how long it lasts, how fast it thinks, what a game costs. */
  summary: string;
  /** Everything else, behind "More stats". */
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

const seconds = (ms: number) => `${(ms / 1000).toFixed(ms < 1000 ? 2 : 1)} s`;

/** In words a non-player follows: survival, thinking time, cost. */
export const summaryOf = (e: LeaderboardEntry): string =>
  [
    `Survives ${Math.round(e.meanSurvivedSeconds)} s`,
    ...(e.meanLatencyMs === null ? [] : [`thinks in ${seconds(e.meanLatencyMs)}`]),
    `$${e.costPerGame.toFixed(3)} a game`,
  ].join(' · ');

const statsOf = (e: LeaderboardEntry): [string, string][] => [
  ['Pellets eaten per life', String(e.pelletsPerLife)],
  ['Ghosts eaten per game', String(e.meanGhostsEaten)],
  ['Fruit eaten', e.fruitEaten],
  ['Moves left to the backup rule', `${(e.fallbackRate * 100).toFixed(1)}%`],
  ['Games played', String(e.games)],
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
    summary: summaryOf(e),
    stats: statsOf(e),
    link: { href: `/?pacman=${encodeURIComponent(e.model)}`, label: `Watch it play →` },
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
    summary: summaryOf(e),
    stats: statsOf(e),
    link: e.url ? { href: e.url, label: `About ${e.name} ↗` } : null,
  }));
}

/** The page's one-line verdict: who is on top (or tied), and by how much. */
export function verdict(board: Leaderboard): string {
  const [first, second] = board.entries;
  if (!first) return '';
  const tied = jointLeaders(board.entries).map((e) => e.name);
  if (tied.length) {
    const names = tied.length > 2 ? `${tied.slice(0, -1).join(', ')} and ${tied.at(-1)}` : tied.join(' and ');
    return `${names} share the top spot: their scores are too close to call.`;
  }
  return second ? `${first.name} plays best, ${(first.meanScore - second.meanScore).toLocaleString('en-US')} points ahead of ${second.name} on average.` : `${first.name} plays best.`;
}
