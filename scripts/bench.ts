// Headless real-time benchmark: how long does Pac-Man survive, and how well does he play?
// Run: npm run bench -- [--games 4] [--pacman jev|greedy] [--ghosts greedy|jev] [--max 120] [--record path.json]
//                       [--pacman-model id] [--ghost-model id]
// Leaderboard: npm run bench -- --models all|id,id [--games 8] [--parallel 4] [--max 300] [--out public/leaderboard.json]
//   plays each model as Pac-Man against the scripted ghosts; every move is the model's own.
// --record needs --games 1 and writes the game (steps, decisions, panel events) for src/replay.ts.
// Your own model: --endpoint https://… plays Pac-Man through your HTTP endpoint (see CONTRIBUTING.md); with
//   --submit submissions/<id> --name "My Model" --by <github-handle> [--url https://…] it plays the leaderboard's
//   games and writes them as a submission to open a pull request with.
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { basename, dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { Scheduler, type Transport } from '../src/scheduler';
import { createGame, step, type Controls } from '../src/sim';
import type { DecideResponse } from '../src/brain';
import { GHOST_IDS, type ActorId } from '../src/types';
import { handleDecide } from '../server/decide';
import { devTargetFromEnv, modelFor } from '../server/jev';
import { Recorder, roundDt, type Recording } from '../src/replay';
import { verifyGame } from './verify';
import { emptyResult, finishResult, scriptedControls } from './game';
import { GameStats } from '../src/stats';
import { DECISION_MODELS, DEFAULT_MODEL, isModelId, modelName, type ModelId } from '../shared/models';
import { BENCH_VERSION, rank, SUBMISSION_RULES, summarize, type GameResult, type Leaderboard, type LeaderboardEntry } from '../shared/leaderboard';

const { values } = parseArgs({
  options: {
    games: { type: 'string' },
    pacman: { type: 'string', default: 'jev' },
    ghosts: { type: 'string', default: 'greedy' },
    max: { type: 'string' },
    record: { type: 'string' },
    // Without these the server's default plays: JEV_MODEL, else jev.
    'pacman-model': { type: 'string' },
    'ghost-model': { type: 'string' },
    models: { type: 'string' },
    parallel: { type: 'string' },
    out: { type: 'string', default: 'public/leaderboard.json' },
    endpoint: { type: 'string' },
    submit: { type: 'string' },
    name: { type: 'string' },
    by: { type: 'string' },
    url: { type: 'string' },
  },
});
const leaderboard = values.models !== undefined;
const submit = values.submit !== undefined;
const games = Number(values.games ?? (leaderboard ? 8 : submit ? SUBMISSION_RULES.minGames : 4));
const maxSeconds = Number(values.max ?? (leaderboard || submit ? SUBMISSION_RULES.maxSeconds : 120));
const fail = (msg: string): never => {
  console.error(msg);
  process.exit(1);
};
const asModel = (v: string): ModelId => (isModelId(v) ? v : fail(`Unknown model ${v}; one of: ${DECISION_MODELS.map((m) => m.id).join(', ')}`));
if (values.record && games !== 1) fail('--record needs --games 1');
if (values.endpoint && (leaderboard || values['pacman-model'] || values.ghosts === 'jev')) fail('--endpoint plays Pac-Man only, instead of --models and --pacman-model');
if (submit) {
  if (!values.name || !values.by) fail('--submit needs --name "Model name" and --by <your GitHub handle>');
  if (!/^[a-z0-9][a-z0-9-]*$/.test(basename(values.submit!))) fail('--submit folder name is the model id: lowercase letters, digits and dashes, e.g. submissions/my-model');
  if (games < SUBMISSION_RULES.minGames) fail(`a submission needs at least ${SUBMISSION_RULES.minGames} games`);
  if (maxSeconds !== SUBMISSION_RULES.maxSeconds) fail(`a submission plays the leaderboard's ${SUBMISSION_RULES.maxSeconds} s games`);
  if (leaderboard || values.pacman === 'greedy' || values.ghosts === 'jev') fail('--submit plays your model as Pac-Man against the scripted ghosts');
}
const FRAME = 1 / 60;

// TYPESAFE_API_KEY calls api.typesafe.ai directly; otherwise OPPER_API_KEY goes through Opper.
const target = devTargetFromEnv(process.env);
const decide = (body: unknown, timeoutMs?: number) =>
  handleDecide(body, { apiKey: target?.apiKey, baseUrl: target?.baseUrl ?? '', provider: target?.provider, fetch, now: () => performance.now(), timeoutMs });
/**
 * A model behind your own HTTP endpoint: it gets the same request body jevman sends System One ({state, questions})
 * and answers {answers: {pacman: {type: 'choice', choice, probabilities?, confidence?}}, usage?, costUsd?}.
 * BENCH_ENDPOINT_TOKEN, if set, is sent as a bearer token.
 */
async function endpointDecide(body: unknown, timeoutMs = 10_000): Promise<{ status: number; body: unknown }> {
  const t0 = performance.now();
  try {
    const { model: _model, ...request } = body as Record<string, unknown>;
    const token = process.env.BENCH_ENDPOINT_TOKEN;
    const res = await fetch(values.endpoint!, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { status: res.status, body: { error: `endpoint answered ${res.status}` } };
    const out = (await res.json()) as { answers?: unknown; usage?: DecideResponse['usage']; costUsd?: number };
    if (!out.answers || typeof out.answers !== 'object') return { status: 502, body: { error: 'endpoint answer has no answers object' } };
    const response: DecideResponse = {
      model: values.name ?? 'endpoint',
      answers: out.answers as DecideResponse['answers'],
      usage: out.usage ?? { input_tokens: 0, output_tokens: 0 },
      latencyMs: Math.round(performance.now() - t0),
      costUsd: typeof out.costUsd === 'number' ? out.costUsd : null,
      traceId: null,
    };
    return { status: 200, body: response };
  } catch (err) {
    return (err as Error).name === 'TimeoutError' ? { status: 504, body: { error: 'endpoint timed out' } } : { status: 502, body: { error: (err as Error).message } };
  }
}
const decideVia = values.endpoint ? endpointDecide : decide;
const transport: Transport = async (body) => {
  const result = await decideVia(body);
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
  for (let attempt = 1; performance.now() - started < 300_000; attempt++) {
    const t0 = performance.now();
    const res = await decideVia(body, 30_000);
    const ms = Math.round(performance.now() - t0);
    // Fast enough for the game's 2 s timeout, with room to spare.
    if (res.status === 200 && ms < 1800) {
      console.log(`  warm: ${nameOf(model)} answered in ${ms} ms (attempt ${attempt})`);
      return null;
    }
    if (res.status !== 200 && res.status !== 504) return `${(res.body as { error: string }).error}`;
  }
  return 'did not answer within 1.8 s in 5 minutes of trying';
}

/** A model's display name; undefined is the server's default. */
const nameOf = (model: ModelId | undefined) => (values.endpoint ? (values.name ?? values.endpoint) : modelName(model ?? modelFor(target?.provider ?? 'opper')));

interface PlayOptions {
  pacman: 'jev' | 'greedy';
  ghosts: 'jev' | 'greedy';
  pacmanModel?: ModelId;
  ghostModel?: ModelId;
  /** Records the game and hands over the recording once it is over. */
  onRecording?: (rec: Recording) => void;
}

async function playOne(opts: PlayOptions): Promise<GameResult> {
  const jevActors: ActorId[] = [...(opts.pacman === 'jev' ? ['pacman' as const] : []), ...(opts.ghosts === 'jev' ? GHOST_IDS : [])];
  const realTime = jevActors.length > 0; // model latency only matters in real time; greedy-only games run flat out
  const state = createGame();
  const r = emptyResult();
  const stats = new GameStats();
  const recorder = opts.onRecording ? new Recorder() : null;
  let frame = 0;
  const scheduler = new Scheduler({
    transport,
    now: () => performance.now(),
    actors: jevActors,
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
  const scripted = scriptedControls();
  const baseCtl: Controls = {
    decide: (point, s) => (jevActors.includes(point.actor) ? scheduler.decide(point, s) : scripted.decide(point, s)),
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
  finishResult(r, stats, state);
  opts.onRecording?.(recorder!.finish(state, values.endpoint ? (values.name ?? 'endpoint') : (opts.pacmanModel ?? modelFor(target?.provider ?? 'opper'))));
  return r;
}

/** Runs `n` games, at most `parallel` at a time. */
async function playMany(n: number, parallel: number, play: () => Promise<GameResult>): Promise<GameResult[]> {
  if (!Number.isInteger(parallel) || parallel < 1) fail('--parallel must be a whole number ≥ 1');
  const results: GameResult[] = [];
  for (let i = 0; i < n; i += parallel) results.push(...(await Promise.all(Array.from({ length: Math.min(parallel, n - i) }, play))));
  return results;
}

/** Writes the games as a submission folder, after checking each one replays the way CI will check it. */
function writeSubmission(recordings: Recording[]): void {
  const dir = values.submit!;
  recordings.forEach((rec, i) => {
    const verdict = verifyGame(rec);
    if (!verdict.ok) fail(`game ${i + 1} does not replay: ${verdict.error}. Please open an issue: this is a jevman bug.`);
  });
  mkdirSync(dir, { recursive: true });
  // A run replaces the folder's games: none of an earlier run may be left behind.
  for (const f of readdirSync(dir)) if (/^game-\d+\.json\.gz$/.test(f)) rmSync(join(dir, f));
  recordings.forEach((rec, i) => writeFileSync(join(dir, `game-${String(i + 1).padStart(2, '0')}.json.gz`), gzipSync(JSON.stringify(rec))));
  const manifest = {
    name: values.name,
    by: values.by,
    ...(values.url ? { url: values.url } : {}),
    benchVersion: BENCH_VERSION,
    recordedAt: new Date().toISOString(),
    games: recordings.length,
  };
  writeFileSync(join(dir, 'submission.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`\nwrote ${recordings.length} games to ${dir}. Check them with npm run submissions, then open a pull request (see CONTRIBUTING.md).`);
}

const line = (r: GameResult) =>
  `survived ${r.survived.toFixed(1)}s, score ${r.score}, pellets ${r.pellets}, deaths ${r.deaths}, level ${r.level}, ghosts ${r.ghostsEaten}, calls ${r.calls}, fallbacks ${r.fallbacks}/${r.decisions}, $${r.cost.toFixed(4)}`;

if (leaderboard) {
  const models = values.models === 'all' || values.models === '' ? DECISION_MODELS.map((m) => m.id) : values.models!.split(',').map(asModel);
  const parallel = Number(values.parallel ?? 4);
  console.log(`leaderboard: ${models.length} models × ${games} games, cap ${maxSeconds}s, ${parallel} at a time, scripted ghosts (via ${target?.provider ?? 'no key'})`);
  const entries: LeaderboardEntry[] = [];
  const skipped: Leaderboard['skipped'] = [];
  const write = () => {
    const board: Leaderboard = { generatedAt: new Date().toISOString(), settings: { gamesPerModel: games, maxSeconds, benchVersion: BENCH_VERSION, ghosts: 'scripted' }, entries: rank(entries), skipped };
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
    const results = await playMany(games, parallel, () => playOne({ pacman: 'jev', ghosts: 'greedy', pacmanModel: model }));
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
  const opts = { pacman, ghosts, pacmanModel: pick(values['pacman-model']), ghostModel: pick(values['ghost-model']) } as const;
  const label = `pacman=${pacman === 'jev' ? nameOf(opts.pacmanModel) : 'greedy'} ghosts=${ghosts === 'jev' ? nameOf(opts.ghostModel) : 'greedy'}`;
  console.log(`bench ${label}: ${games} games, cap ${maxSeconds}s${pacman === 'jev' || ghosts === 'jev' ? ` (real time, via ${target?.provider ?? 'no key'})` : ''}`);
  const warm = async (model: ModelId | undefined) => {
    const problem = await warmUp(model);
    if (problem) fail(`${model}: ${problem}`);
  };
  if (pacman === 'jev') await warm(opts.pacmanModel);
  if (ghosts === 'jev' && (pacman !== 'jev' || opts.ghostModel !== opts.pacmanModel)) await warm(opts.ghostModel);
  const recordings: Recording[] = [];
  const onRecording = submit
    ? (rec: Recording) => recordings.push(rec)
    : values.record
      ? (rec: Recording) => {
          const out = JSON.stringify(rec);
          mkdirSync(dirname(values.record!), { recursive: true });
          writeFileSync(values.record!, out);
          console.log(`recorded ${rec.frames.length} frames to ${values.record} (${(out.length / 1024).toFixed(0)} KB)`);
        }
      : undefined;
  const parallel = Number(values.parallel ?? (submit ? 4 : games));
  const results = await playMany(games, parallel, () => playOne({ ...opts, onRecording }));
  for (const [i, r] of results.entries()) console.log(`  game ${i + 1}: ${line(r)}`);
  if (submit) writeSubmission(recordings);
  const e = summarize(opts.pacmanModel ?? DEFAULT_MODEL, results);
  console.log(`deaths by situation: ${JSON.stringify(e.deathsBy)}`);
  console.log(`MEAN ${label}: score ${e.meanScore}, survived ${e.meanSurvivedSeconds}s, pellets ${e.meanPellets}, pellets/life ${e.pelletsPerLife}, ghosts ${e.meanGhostsEaten}, fruit eaten ${e.fruitEaten}, fallbacks ${(e.fallbackRate * 100).toFixed(1)}%, latency ${e.meanLatencyMs ?? '–'} ms, cost $${e.costPerGame.toFixed(4)}/game`);
}
