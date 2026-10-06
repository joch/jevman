import { modelName, type ModelId } from './models.ts';

/** One benchmark game, as scripts/bench.ts plays it. */
export interface GameResult {
  survived: number;
  score: number;
  pellets: number;
  deaths: number;
  level: number;
  calls: number;
  decisions: number;
  fallbacks: number;
  latencyMsSum: number;
  cost: number;
  fruitSpawned: number;
  fruitEaten: number;
  ghostsEaten: number;
  deathsBy: Record<string, number>;
}

/**
 * Bump when the game rules or the question the models get change: results from another version are not comparable,
 * and submissions recorded on it are refused. tests/bench-version.test.ts fails when either changes.
 */
export const BENCH_VERSION = 1;

export interface LeaderboardEntry {
  /** A model id from shared/models.ts, or a submitted model's own id. */
  model: string;
  name: string;
  games: number;
  meanScore: number;
  /** Standard error of the mean score: about two of these either way is the margin of error. */
  scoreStdError?: number;
  meanSurvivedSeconds: number;
  meanPellets: number;
  pelletsPerLife: number;
  meanGhostsEaten: number;
  fruitEaten: string;
  bestLevel: number;
  /** Share of decisions the greedy rule made because the model did not answer in time (or at all). */
  fallbackRate: number;
  meanLatencyMs: number | null;
  costPerGame: number;
  deathsBy: Record<string, number>;
}

export interface Leaderboard {
  generatedAt: string;
  settings: { gamesPerModel: number; maxSeconds: number; /** Missing in results from before versioning (version 1). */ benchVersion?: number; /** Only in results from before the game's safety check was removed. */ safetyCheck?: boolean; ghosts: 'scripted' };
  /** Best first: by mean score. */
  entries: LeaderboardEntry[];
  /** Models that could not play (not warm in time, not enabled for the key, ...). */
  skipped: { model: ModelId; reason: string }[];
}

const round = (n: number, places = 0) => Math.round(n * 10 ** places) / 10 ** places;

export function summarize(model: string, games: GameResult[], name: string = modelName(model)): LeaderboardEntry {
  const mean = (f: (g: GameResult) => number) => (games.length ? games.reduce((a, g) => a + f(g), 0) / games.length : 0);
  const sum = (f: (g: GameResult) => number) => games.reduce((a, g) => a + f(g), 0);
  const deathsBy: Record<string, number> = {};
  for (const g of games) for (const [k, v] of Object.entries(g.deathsBy)) deathsBy[k] = (deathsBy[k] ?? 0) + v;
  const calls = sum((g) => g.calls);
  const decisions = sum((g) => g.decisions);
  return {
    model,
    name,
    games: games.length,
    meanScore: round(mean((g) => g.score)),
    scoreStdError: round(stdError(games.map((g) => g.score))),
    meanSurvivedSeconds: round(mean((g) => g.survived), 1),
    meanPellets: round(mean((g) => g.pellets)),
    pelletsPerLife: round(sum((g) => g.pellets) / Math.max(1, sum((g) => g.deaths))),
    meanGhostsEaten: round(mean((g) => g.ghostsEaten), 1),
    fruitEaten: `${sum((g) => g.fruitEaten)}/${sum((g) => g.fruitSpawned)}`,
    bestLevel: Math.max(1, ...games.map((g) => g.level)),
    fallbackRate: decisions ? round(sum((g) => g.fallbacks) / decisions, 3) : 0,
    meanLatencyMs: calls ? round(sum((g) => g.latencyMsSum) / calls) : null,
    costPerGame: round(mean((g) => g.cost), 5),
    deathsBy,
  };
}

function stdError(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = xs.reduce((a, x) => a + x, 0) / xs.length;
  const variance = xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(variance / xs.length);
}

/** Whether two models' mean scores are within the margin of error (about two standard errors of the difference). */
export function tooCloseToCall(a: LeaderboardEntry, b: LeaderboardEntry): boolean {
  if (a.scoreStdError === undefined || b.scoreStdError === undefined) return false;
  return Math.abs(a.meanScore - b.meanScore) < 2 * Math.hypot(a.scoreStdError, b.scoreStdError);
}

/** The models tied for first: the leader and every other model within the margin of error of it. */
export function jointLeaders(entries: LeaderboardEntry[]): LeaderboardEntry[] {
  if (entries.length < 2) return [];
  const tied = [entries[0], ...entries.slice(1).filter((e) => tooCloseToCall(entries[0], e))];
  return tied.length > 1 ? tied : [];
}

export const rank = (entries: LeaderboardEntry[]): LeaderboardEntry[] => [...entries].sort((a, b) => b.meanScore - a.meanScore);

/** A model its makers benchmarked themselves and submitted by pull request (submissions/<id>/). */
export interface CommunityEntry extends LeaderboardEntry {
  /** Who submitted it (GitHub handle or organisation). */
  by: string;
  /** Where to learn more about the model. */
  url?: string;
  /**
   * Always true. The games were replayed and their scores checked, but the moves, latency, cost and choice of games
   * are as reported by the submitter.
   */
  selfReported: true;
}

export interface Community {
  generatedAt: string;
  benchVersion: number;
  /** Best first: by mean score. */
  entries: CommunityEntry[];
}

/** The rules every submission (and our own leaderboard run) follows. */
export interface SubmissionRules {
  minGames: number;
  /** Each game ends at game over or after this many seconds of play. */
  maxSeconds: number;
  /** The longest simulation step the bench takes (it caps a slow frame at 50 ms). */
  maxStep: number;
}
export const SUBMISSION_RULES: SubmissionRules = { minGames: 24, maxSeconds: 300, maxStep: 0.05 };
