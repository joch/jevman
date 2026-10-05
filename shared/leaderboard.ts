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
  overrides: number;
  latencyMsSum: number;
  cost: number;
  fruitSpawned: number;
  fruitEaten: number;
  ghostsEaten: number;
  deathsBy: Record<string, number>;
}

export interface LeaderboardEntry {
  model: ModelId;
  name: string;
  games: number;
  meanScore: number;
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
  settings: { gamesPerModel: number; maxSeconds: number; safetyCheck: boolean; ghosts: 'scripted' };
  /** Best first: by mean score. */
  entries: LeaderboardEntry[];
}

const round = (n: number, places = 0) => Math.round(n * 10 ** places) / 10 ** places;

export function summarize(model: ModelId, games: GameResult[]): LeaderboardEntry {
  const mean = (f: (g: GameResult) => number) => (games.length ? games.reduce((a, g) => a + f(g), 0) / games.length : 0);
  const sum = (f: (g: GameResult) => number) => games.reduce((a, g) => a + f(g), 0);
  const deathsBy: Record<string, number> = {};
  for (const g of games) for (const [k, v] of Object.entries(g.deathsBy)) deathsBy[k] = (deathsBy[k] ?? 0) + v;
  const calls = sum((g) => g.calls);
  const decisions = sum((g) => g.decisions);
  return {
    model,
    name: modelName(model),
    games: games.length,
    meanScore: round(mean((g) => g.score)),
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

export const rank = (entries: LeaderboardEntry[]): LeaderboardEntry[] => [...entries].sort((a, b) => b.meanScore - a.meanScore);
