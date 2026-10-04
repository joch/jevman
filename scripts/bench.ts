// Headless real-time benchmark: how long does Pac-Man survive, and how well does he play?
// Run: npm run bench -- [--games 4] [--pacman jev|greedy] [--ghosts greedy|jev] [--max 120] [--record path.json]
// --record needs --games 1 and writes the game (steps, decisions, panel events) for src/replay.ts.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { greedyChoice, optionFeatures } from '../src/features';
import { Scheduler, type Transport } from '../src/scheduler';
import { createGame, step, type Controls } from '../src/sim';
import type { DecideResponse } from '../src/brain';
import { GHOST_IDS, type ActorId } from '../src/types';
import { handleDecide } from '../server/decide';
import { devTargetFromEnv, modelFor } from '../server/jev';
import { Recorder, roundDt } from '../src/replay';
import { deathContext, GameStats } from '../src/stats';

const { values } = parseArgs({
  options: {
    games: { type: 'string', default: '4' },
    pacman: { type: 'string', default: 'jev' },
    ghosts: { type: 'string', default: 'greedy' },
    max: { type: 'string', default: '120' },
    record: { type: 'string' },
  },
});
const games = Number(values.games);
const maxSeconds = Number(values.max);
if (values.record && games !== 1) {
  console.error('--record needs --games 1');
  process.exit(1);
}
const jevActors: ActorId[] = [...(values.pacman === 'jev' ? ['pacman' as const] : []), ...(values.ghosts === 'jev' ? GHOST_IDS : [])];
const realTime = jevActors.length > 0; // jev latency only matters in real time; greedy-only games run flat out
const FRAME = 1 / 60;

// TYPESAFE_API_KEY calls api.typesafe.ai directly; otherwise OPPER_API_KEY goes through Opper.
const target = devTargetFromEnv(process.env);

const transport: Transport = async (body) => {
  const result = await handleDecide(body, {
    apiKey: target?.apiKey,
    baseUrl: target?.baseUrl ?? '',
    provider: target?.provider,
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
  fruitSpawned: number;
  fruitEaten: number;
}

async function playOne(): Promise<Result> {
  const state = createGame();
  const r: Result = { deathsBy: {}, escapes: 0, turnBacks: 0, survived: 0, score: 0, pellets: 0, deaths: 0, level: 1, calls: 0, fallbacks: 0, cost: 0, fruitSpawned: 0, fruitEaten: 0 };
  const stats = new GameStats();
  const recorder = values.record ? new Recorder() : null;
  let frame = 0;
  const scheduler = new Scheduler({
    transport,
    now: () => performance.now(),
    actors: jevActors,
    onEvent: (e) => {
      recorder?.record(frame, e);
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
  // Like the scheduler, answer each escape question once; afterwards Pac-Man just keeps going.
  const answeredEscapes = new Set<string>();
  const baseCtl: Controls = {
    decide: (point) => {
      if (jevActors.includes(point.actor)) return scheduler.decide(point);
      if (point.escape) {
        if (answeredEscapes.has(point.key)) return null;
        answeredEscapes.add(point.key);
      }
      const choice = greedyChoice(state, point, optionFeatures(state, point));
      if (point.escape) {
        r.escapes += 1;
        if (choice === point.options[1]) r.turnBacks += 1;
      }
      return choice;
    },
  };
  const ctl = recorder ? recorder.wrap(baseCtl, () => frame) : baseCtl;
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
    if (recorder) {
      dt = roundDt(dt);
      recorder.frames.push(dt);
    }
    scheduler.update(state);
    const before = deathContext(state);
    const fruitBefore = state.fruit;
    stats.beforeStep(state);
    step(state, dt, ctl);
    stats.afterStep(state, dt);
    if (!fruitBefore && state.fruit) r.fruitSpawned += 1;
    for (const a of [state.pacman, ...GHOST_IDS.map((id) => state.ghosts[id])]) {
      if (a.id !== 'pacman' && state.ghosts[a.id].state === 'house') continue;
      const into = state.maze.neighbor(a.tile, a.dir);
      if (!state.maze.isWalkable(a.tile) || (a.progress > 0 && !state.maze.isWalkable(into))) {
        throw new Error(`${a.id} left the maze at (${a.tile.x},${a.tile.y}) heading ${a.dir}, progress ${a.progress.toFixed(2)}`);
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
    frame += 1;
  }
  r.score = state.score;
  r.fruitEaten = stats.summary(state).fruit.length;
  r.pellets = pelletsEaten;
  r.level = state.level;
  if (recorder) {
    const out = JSON.stringify(recorder.finish(state, modelFor(target?.provider ?? 'opper')));
    mkdirSync(dirname(values.record!), { recursive: true });
    writeFileSync(values.record!, out);
    console.log(`recorded ${recorder.frames.length} frames to ${values.record} (${(out.length / 1024).toFixed(0)} KB)`);
  }
  return r;
}

const label = `pacman=${values.pacman} ghosts=${values.ghosts}`;
console.log(`bench ${label}: ${games} games, cap ${maxSeconds}s${realTime ? ` (real time, via ${target?.provider ?? 'no key'})` : ''}`);
const results = await Promise.all(Array.from({ length: games }, playOne));
const mean = (f: (r: Result) => number) => results.reduce((a, r) => a + f(r), 0) / results.length;
for (const [i, r] of results.entries()) {
  console.log(`  game ${i + 1}: survived ${r.survived.toFixed(1)}s, score ${r.score}, pellets ${r.pellets}, deaths ${r.deaths}, level ${r.level}, calls ${r.calls}, fallbacks ${r.fallbacks}, escapes ${r.escapes} (turned back ${r.turnBacks}), $${r.cost.toFixed(4)}`);
}
const deathsBy: Record<string, number> = {};
for (const r of results) for (const [k, v] of Object.entries(r.deathsBy)) deathsBy[k] = (deathsBy[k] ?? 0) + v;
console.log(`deaths by situation: ${JSON.stringify(deathsBy)}`);
console.log(
  `MEAN ${label}: survived ${mean((r) => r.survived).toFixed(1)}s, score ${mean((r) => r.score).toFixed(0)}, pellets ${mean((r) => r.pellets).toFixed(0)}, pellets/life ${mean((r) => r.pellets / Math.max(1, r.deaths)).toFixed(0)}, fallbacks ${mean((r) => r.fallbacks).toFixed(1)}, fruit eaten ${results.reduce((a, r) => a + r.fruitEaten, 0)}/${results.reduce((a, r) => a + r.fruitSpawned, 0)}, cost $${mean((r) => r.cost).toFixed(4)}/game`,
);
