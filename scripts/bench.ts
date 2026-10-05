// Headless real-time benchmark: how long does Pac-Man survive, and how well does he play?
// Run: npm run bench -- [--games 4] [--pacman jev|greedy] [--ghosts greedy|jev] [--max 120] [--record path.json]
//                       [--pacman-model id] [--ghost-model id] [--safety on|off]
// Leaderboard: npm run bench -- --models all|id,id [--games 8] [--parallel 4] [--max 300] [--out bench/leaderboard.json]
//   plays each model as Pac-Man against the scripted ghosts with the safety check off, so the model is measured.
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
import { GameStats } from '../src/stats';
import { DECISION_MODELS, DEFAULT_MODEL, isModelId, modelName, type ModelId } from '../shared/models';
import { rank, summarize, type GameResult, type Leaderboard, type LeaderboardEntry } from '../shared/leaderboard';

const { values } = parseArgs({
  options: {
    games: { type: 'string' },
    pacman: { type: 'string', default: 'jev' },
    ghosts: { type: 'string', default: 'greedy' },
    max: { type: 'string' },
    record: { type: 'string' },
    safety: { type: 'string' },
    // Without these the server's default plays: JEV_MODEL, else jev.
    'pacman-model': { type: 'string' },
    'ghost-model': { type: 'string' },
    models: { type: 'string' },
    parallel: { type: 'string' },
    out: { type: 'string', default: 'bench/leaderboard.json' },
  },
});
const leaderboard = values.models !== undefined;
const games = Number(values.games ?? (leaderboard ? 8 : 4));
const maxSeconds = Number(values.max ?? (leaderboard ? 300 : 120));
const safetyCheck = (values.safety ?? (leaderboard ? 'off' : 'on')) !== 'off';
const fail = (msg: string): never => {
  console.error(msg);
  process.exit(1);
};
const asModel = (v: string): ModelId => (isModelId(v) ? v : fail(`Unknown model ${v}; one of: ${DECISION_MODELS.map((m) => m.id).join(', ')}`));
if (values.record && games !== 1) fail('--record needs --games 1');
const FRAME = 1 / 60;

// TYPESAFE_API_KEY calls api.typesafe.ai directly; otherwise OPPER_API_KEY goes through Opper.
const target = devTargetFromEnv(process.env);
const decide = (body: unknown, timeoutMs?: number) =>
  handleDecide(body, { apiKey: target?.apiKey, baseUrl: target?.baseUrl ?? '', provider: target?.provider, fetch, now: () => performance.now(), timeoutMs });
const transport: Transport = async (body) => {
  const result = await decide(body);
  if (result.status !== 200) throw new Error((result.body as { error: string }).error);
  return result.body as DecideResponse;
};

/**
 * Opper-hosted models scale down when idle and the first calls can take many seconds; a game would turn them into
 * fallbacks. Call until one answer comes back quickly.
 */
async function warmUp(model: ModelId | undefined): Promise<string | null> {
  const body = { ...(model ? { model } : {}), state: { note: 'warm-up' }, questions: { warmup: { type: 'choice', instructions: 'Pick one.', criteria: { a: 'Option A', b: 'Option B' } } } };
  const started = performance.now();
  for (let attempt = 1; performance.now() - started < 120_000; attempt++) {
    const t0 = performance.now();
    const res = await decide(body, 30_000);
    const ms = Math.round(performance.now() - t0);
    // Fast enough for the game's 2 s timeout, with room to spare.
    if (res.status === 200 && ms < 1800) {
      console.log(`  warm: ${nameOf(model)} answered in ${ms} ms (attempt ${attempt})`);
      return null;
    }
    if (res.status !== 200 && res.status !== 504) return `${(res.body as { error: string }).error}`;
  }
  return 'did not answer within 1.8 s in 2 minutes of trying';
}

/** A model's display name; undefined is the server's default. */
const nameOf = (model: ModelId | undefined) => modelName(model ?? modelFor(target?.provider ?? 'opper'));

async function playOne(opts: { pacman: 'jev' | 'greedy'; ghosts: 'jev' | 'greedy'; pacmanModel?: ModelId; ghostModel?: ModelId; safetyCheck: boolean }): Promise<GameResult> {
  const jevActors: ActorId[] = [...(opts.pacman === 'jev' ? ['pacman' as const] : []), ...(opts.ghosts === 'jev' ? GHOST_IDS : [])];
  const realTime = jevActors.length > 0; // model latency only matters in real time; greedy-only games run flat out
  const state = createGame();
  const r: GameResult = { survived: 0, score: 0, pellets: 0, deaths: 0, level: 1, calls: 0, decisions: 0, fallbacks: 0, overrides: 0, latencyMsSum: 0, cost: 0, fruitSpawned: 0, fruitEaten: 0, ghostsEaten: 0, deathsBy: {} };
  const stats = new GameStats();
  const recorder = values.record ? new Recorder() : null;
  let frame = 0;
  const scheduler = new Scheduler({
    transport,
    now: () => performance.now(),
    actors: jevActors,
    safetyCheck: opts.safetyCheck,
    modelFor: (a) => (a === 'pacman' ? opts.pacmanModel : opts.ghostModel),
    onEvent: (e) => {
      recorder?.record(frame, e);
      stats.onSchedulerEvent(e);
      if (e.type === 'call') {
        r.calls += 1;
        r.cost += e.costUsd ?? 0;
        if (Number.isFinite(e.latencyMs)) r.latencyMsSum += e.latencyMs;
      }
    },
  });
  // Like the scheduler, answer each escape question once; afterwards Pac-Man just keeps going.
  const answeredEscapes = new Set<string>();
  const baseCtl: Controls = {
    decide: (point, s) => {
      if (jevActors.includes(point.actor)) return scheduler.decide(point, s);
      if (point.escape) {
        if (answeredEscapes.has(point.key)) return null;
        answeredEscapes.add(point.key);
      }
      return greedyChoice(s, point, optionFeatures(s, point));
    },
  };
  const ctl = recorder ? recorder.wrap(baseCtl, () => frame) : baseCtl;
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
    if (state.status === 'playing') r.survived += dt;
    frame += 1;
  }
  const summary = stats.summary(state);
  Object.assign(r, {
    score: state.score,
    level: state.level,
    pellets: summary.pellets,
    deaths: summary.deaths.length,
    decisions: summary.jev.decisions,
    fallbacks: summary.jev.fallbacks,
    overrides: summary.jev.overrides,
    fruitEaten: summary.fruit.length,
    ghostsEaten: summary.ghostsEaten,
  });
  for (const d of summary.deaths) r.deathsBy[d.context] = (r.deathsBy[d.context] ?? 0) + 1;
  if (recorder) {
    const out = JSON.stringify(recorder.finish(state, opts.pacmanModel ?? modelFor(target?.provider ?? 'opper')));
    mkdirSync(dirname(values.record!), { recursive: true });
    writeFileSync(values.record!, out);
    console.log(`recorded ${recorder.frames.length} frames to ${values.record} (${(out.length / 1024).toFixed(0)} KB)`);
  }
  return r;
}

/** Runs `n` games, at most `parallel` at a time. */
async function playMany(n: number, parallel: number, play: () => Promise<GameResult>): Promise<GameResult[]> {
  if (!Number.isInteger(parallel) || parallel < 1) fail('--parallel must be a whole number ≥ 1');
  const results: GameResult[] = [];
  for (let i = 0; i < n; i += parallel) results.push(...(await Promise.all(Array.from({ length: Math.min(parallel, n - i) }, play))));
  return results;
}

const line = (r: GameResult) =>
  `survived ${r.survived.toFixed(1)}s, score ${r.score}, pellets ${r.pellets}, deaths ${r.deaths}, level ${r.level}, ghosts ${r.ghostsEaten}, calls ${r.calls}, fallbacks ${r.fallbacks}/${r.decisions}, overrides ${r.overrides}, $${r.cost.toFixed(4)}`;

if (leaderboard) {
  const models = values.models === 'all' || values.models === '' ? DECISION_MODELS.map((m) => m.id) : values.models!.split(',').map(asModel);
  const parallel = Number(values.parallel ?? 4);
  console.log(`leaderboard: ${models.length} models × ${games} games, cap ${maxSeconds}s, ${parallel} at a time, safety check ${safetyCheck ? 'on' : 'off'}, scripted ghosts (via ${target?.provider ?? 'no key'})`);
  const entries: LeaderboardEntry[] = [];
  const skipped: Leaderboard['skipped'] = [];
  const write = () => {
    const board: Leaderboard = { generatedAt: new Date().toISOString(), settings: { gamesPerModel: games, maxSeconds, safetyCheck, ghosts: 'scripted' }, entries: rank(entries), skipped };
    mkdirSync(dirname(values.out!), { recursive: true });
    writeFileSync(values.out!, `${JSON.stringify(board, null, 2)}\n`);
    return board;
  };
  for (const model of models) {
    console.log(`\n${modelName(model)} (${model})`);
    const problem = await warmUp(model);
    if (problem) {
      // One unavailable model must not cost the others' results.
      console.log(`  skipped: ${problem}`);
      skipped.push({ model, reason: problem });
      write();
      continue;
    }
    const results = await playMany(games, parallel, () => playOne({ pacman: 'jev', ghosts: 'greedy', pacmanModel: model, safetyCheck }));
    for (const [i, r] of results.entries()) console.log(`  game ${i + 1}: ${line(r)}`);
    const entry = summarize(model, results);
    console.log(`  MEAN score ${entry.meanScore}, survived ${entry.meanSurvivedSeconds}s, pellets/life ${entry.pelletsPerLife}, fallbacks ${(entry.fallbackRate * 100).toFixed(1)}%, latency ${entry.meanLatencyMs} ms, $${entry.costPerGame}/game`);
    entries.push(entry);
    write(); // after every model, so an interrupted run keeps what it has
  }
  const board = write();
  console.log(`\n${'model'.padEnd(12)} ${'score'.padStart(6)} ${'survived'.padStart(9)} ${'pel/life'.padStart(9)} ${'fallback'.padStart(9)} ${'latency'.padStart(8)} ${'$/game'.padStart(8)}`);
  for (const s of board.skipped) console.log(`${modelName(s.model).padEnd(12)} skipped: ${s.reason}`);
  for (const e of board.entries) {
    console.log(`${e.name.padEnd(12)} ${String(e.meanScore).padStart(6)} ${`${e.meanSurvivedSeconds}s`.padStart(9)} ${String(e.pelletsPerLife).padStart(9)} ${`${(e.fallbackRate * 100).toFixed(1)}%`.padStart(9)} ${`${e.meanLatencyMs ?? '–'} ms`.padStart(8)} ${e.costPerGame.toFixed(4).padStart(8)}`);
  }
  console.log(`\nwrote ${values.out}`);
} else {
  const pacman = values.pacman === 'greedy' ? 'greedy' : 'jev';
  const ghosts = values.ghosts === 'jev' ? 'jev' : 'greedy';
  const pick = (v: string | undefined) => (v === undefined ? undefined : asModel(v));
  const opts = { pacman, ghosts, pacmanModel: pick(values['pacman-model']), ghostModel: pick(values['ghost-model']), safetyCheck } as const;
  const label = `pacman=${pacman === 'jev' ? nameOf(opts.pacmanModel) : 'greedy'} ghosts=${ghosts === 'jev' ? nameOf(opts.ghostModel) : 'greedy'}`;
  console.log(`bench ${label}: ${games} games, cap ${maxSeconds}s, safety check ${safetyCheck ? 'on' : 'off'}${pacman === 'jev' || ghosts === 'jev' ? ` (real time, via ${target?.provider ?? 'no key'})` : ''}`);
  const warm = async (model: ModelId | undefined) => {
    const problem = await warmUp(model);
    if (problem) fail(`${model}: ${problem}`);
  };
  if (pacman === 'jev') await warm(opts.pacmanModel);
  if (ghosts === 'jev' && (pacman !== 'jev' || opts.ghostModel !== opts.pacmanModel)) await warm(opts.ghostModel);
  const results = await playMany(games, games, () => playOne(opts));
  for (const [i, r] of results.entries()) console.log(`  game ${i + 1}: ${line(r)}`);
  const e = summarize(opts.pacmanModel ?? DEFAULT_MODEL, results);
  console.log(`deaths by situation: ${JSON.stringify(e.deathsBy)}`);
  console.log(`MEAN ${label}: score ${e.meanScore}, survived ${e.meanSurvivedSeconds}s, pellets ${e.meanPellets}, pellets/life ${e.pelletsPerLife}, ghosts ${e.meanGhostsEaten}, fruit eaten ${e.fruitEaten}, fallbacks ${(e.fallbackRate * 100).toFixed(1)}%, latency ${e.meanLatencyMs ?? '–'} ms, cost $${e.costPerGame.toFixed(4)}/game`);
}
