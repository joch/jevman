// Headless real-time benchmark: how long does Pac-Man survive, and how well does he play?
// Run: npm run bench -- [--games 4] [--pacman jev|greedy] [--ghosts greedy|jev] [--max 120]
import { parseArgs } from 'node:util';
import { greedyChoice, optionFeatures } from '../src/features';
import { Scheduler, type Transport } from '../src/scheduler';
import { createGame, escapePoint, step, type Controls } from '../src/sim';
import { REVERSE } from '../src/maze';
import type { DecideResponse } from '../src/brain';
import { GHOST_IDS, type ActorId } from '../src/types';
import { handleDecide } from '../server/decide';

const { values } = parseArgs({
  options: {
    games: { type: 'string', default: '4' },
    pacman: { type: 'string', default: 'jev' },
    ghosts: { type: 'string', default: 'greedy' },
    max: { type: 'string', default: '120' },
  },
});
const games = Number(values.games);
const maxSeconds = Number(values.max);
const jevActors: ActorId[] = [...(values.pacman === 'jev' ? ['pacman' as const] : []), ...(values.ghosts === 'jev' ? GHOST_IDS : [])];
const realTime = jevActors.length > 0; // jev latency only matters in real time; greedy-only games run flat out
const FRAME = 1 / 60;

const transport: Transport = async (body) => {
  const result = await handleDecide(body, {
    apiKey: process.env.OPPER_API_KEY,
    baseUrl: process.env.OPPER_BASE_URL || 'https://api.opper.ai',
    fetch,
    now: () => performance.now(),
  });
  if (result.status !== 200) throw new Error((result.body as { error: string }).error);
  return result.body as DecideResponse;
};

interface Result {
  /** What Pac-Man was doing when each life was lost. */
  deathsBy: Record<string, number>;
  escapes: number;
  turnBacks: number;
  survived: number;
  score: number;
  pellets: number;
  deaths: number;
  level: number;
  calls: number;
  fallbacks: number;
  cost: number;
}

/** Classifies Pac-Man's situation in the frame before a death. */
function deathContext(state: ReturnType<typeof createGame>): string | null {
  if (state.status !== 'playing') return null;
  const p = state.pacman;
  if (p.waiting) return 'waiting at junction';
  if (escapePoint(state)) return 'ghost ahead in corridor';
  const back = { ...p, dir: REVERSE[p.dir] };
  const behind = escapePoint({ ...state, pacman: back });
  if (behind) return 'ghost from behind';
  return 'at/near junction';
}

async function playOne(): Promise<Result> {
  const state = createGame();
  const r: Result = { deathsBy: {}, escapes: 0, turnBacks: 0, survived: 0, score: 0, pellets: 0, deaths: 0, level: 1, calls: 0, fallbacks: 0, cost: 0 };
  const scheduler = new Scheduler({
    transport,
    now: () => performance.now(),
    actors: jevActors,
    onEvent: (e) => {
      if (e.type === 'call') {
        r.calls += 1;
        r.cost += e.costUsd ?? 0;
      } else if (e.type === 'decision') {
        if (e.decision.source === 'fallback') r.fallbacks += 1;
        if (e.decision.escape) {
          r.escapes += 1;
          if (e.decision.choice === e.decision.options[1]) r.turnBacks += 1;
        }
      }
    },
  });
  const ctl: Controls = {
    decide: (point) =>
      jevActors.includes(point.actor) ? scheduler.decide(point) : greedyChoice(state, point, optionFeatures(state, point)),
  };
  let lives = state.lives;
  let pelletsEaten = 0;
  let lastPellets = state.pelletsEaten;
  let last = performance.now();
  while (state.status !== 'gameover' && r.survived < maxSeconds) {
    let dt = FRAME;
    if (realTime) {
      await new Promise((res) => setTimeout(res, 16));
      const now = performance.now();
      dt = Math.min(0.05, (now - last) / 1000);
      last = now;
    }
    scheduler.update(state);
    const before = deathContext(state);
    step(state, dt, ctl);
    for (const a of [state.pacman, ...GHOST_IDS.map((id) => state.ghosts[id])]) {
      if (a.progress === 0 && !state.maze.isWalkable(a.tile) && !(a.id !== 'pacman' && state.ghosts[a.id].state === 'house')) {
        throw new Error(`${a.id} left the maze at (${a.tile.x},${a.tile.y})`);
      }
    }
    if (state.status === 'dying' && before) {
      r.deathsBy[before] = (r.deathsBy[before] ?? 0) + 1;
    }
    if (state.status === 'playing') r.survived += dt;
    if (state.pelletsEaten !== lastPellets) {
      pelletsEaten += Math.max(0, state.pelletsEaten - lastPellets);
      lastPellets = state.pelletsEaten;
    }
    if (state.lives < lives) {
      r.deaths += lives - state.lives;
      lives = state.lives;
    }
  }
  r.score = state.score;
  r.pellets = pelletsEaten;
  r.level = state.level;
  return r;
}

const label = `pacman=${values.pacman} ghosts=${values.ghosts}`;
console.log(`bench ${label}: ${games} games, cap ${maxSeconds}s${realTime ? ' (real time)' : ''}`);
const results = await Promise.all(Array.from({ length: games }, playOne));
const mean = (f: (r: Result) => number) => results.reduce((a, r) => a + f(r), 0) / results.length;
for (const [i, r] of results.entries()) {
  console.log(`  game ${i + 1}: survived ${r.survived.toFixed(1)}s, score ${r.score}, pellets ${r.pellets}, deaths ${r.deaths}, level ${r.level}, calls ${r.calls}, fallbacks ${r.fallbacks}, escapes ${r.escapes} (turned back ${r.turnBacks}), $${r.cost.toFixed(4)}`);
}
const deathsBy: Record<string, number> = {};
for (const r of results) for (const [k, v] of Object.entries(r.deathsBy)) deathsBy[k] = (deathsBy[k] ?? 0) + v;
console.log(`deaths by situation: ${JSON.stringify(deathsBy)}`);
console.log(
  `MEAN ${label}: survived ${mean((r) => r.survived).toFixed(1)}s, score ${mean((r) => r.score).toFixed(0)}, pellets ${mean((r) => r.pellets).toFixed(0)}, pellets/life ${mean((r) => r.pellets / Math.max(1, r.deaths)).toFixed(0)}, fallbacks ${mean((r) => r.fallbacks).toFixed(1)}, cost $${mean((r) => r.cost).toFixed(4)}/game`,
);
