// Replays a submitted game and recomputes its result. The game is deterministic: the recorded steps and Pac-Man's
// recorded moves, with the ghosts on the scripted rule, must give the recorded game, or the submission is refused.
import type { Recording } from '../src/replay';
import type { SchedulerEvent } from '../src/scheduler';
import { createGame, step } from '../src/sim';
import { GameStats } from '../src/stats';
import type { Dir } from '../src/types';
import { SUBMISSION_RULES, type GameResult, type SubmissionRules } from '../shared/leaderboard';
import { emptyResult, finishResult, scriptedControls } from './game';

export type Verdict = { ok: true; result: GameResult } | { ok: false; error: string };

const DIRS = new Set<unknown>(['up', 'down', 'left', 'right']);

export function verifyGame(rec: Recording, rules: SubmissionRules = SUBMISSION_RULES): Verdict {
  const fail = (error: string): Verdict => ({ ok: false, error });
  if (rec?.version !== 1) return fail('not a version 1 recording');
  if (!Array.isArray(rec.frames) || !Array.isArray(rec.decisions) || !Array.isArray(rec.events)) return fail('frames, decisions and events must be lists');
  const badStep = rec.frames.findIndex((dt) => typeof dt !== 'number' || !(dt > 0) || dt > rules.maxStep);
  if (badStep >= 0) return fail(`frame ${badStep}: a step must be more than 0 and at most ${rules.maxStep} s`);

  // Only Pac-Man's moves come from the recording; the ghosts play by the scripted rule, as in every benchmark game.
  const moves = new Map<string, Dir[]>();
  let pacmanMoves = 0;
  for (const d of rec.decisions) {
    if (!Array.isArray(d) || !Number.isInteger(d[0]) || typeof d[1] !== 'string' || !DIRS.has(d[2])) return fail('malformed decision');
    // Junction keys are pacman@…, escape keys pacman~…; the ghosts' keys start with their names.
    if (!/^pacman[@~]/.test(d[1])) continue;
    moves.set(`${d[0]}|${d[1]}`, [...(moves.get(`${d[0]}|${d[1]}`) ?? []), d[2]]);
    pacmanMoves += 1;
  }
  const events = new Map<number, SchedulerEvent[]>();
  for (const e of rec.events) {
    if (!Array.isArray(e) || !Number.isInteger(e[0]) || typeof e[1]?.type !== 'string') return fail('malformed event');
    const event = (e[1].type === 'call' ? { ...e[1], traceId: null } : e[1]) as SchedulerEvent;
    events.set(e[0], [...(events.get(e[0]) ?? []), event]);
  }

  const state = createGame();
  const stats = new GameStats();
  const r = emptyResult();
  const scripted = scriptedControls();
  let used = 0;
  let illegal: string | null = null;
  try {
    for (let f = 0; f < rec.frames.length; f++) {
      if (state.status === 'gameover') return fail(`frames go on after game over (frame ${f})`);
      if (r.survived >= rules.maxSeconds) return fail(`frames go on past the ${rules.maxSeconds} s cap (frame ${f})`);
      for (const e of events.get(f) ?? []) {
        stats.onSchedulerEvent(e);
        if (e.type === 'call') {
          r.calls += 1;
          r.cost += typeof e.costUsd === 'number' ? e.costUsd : 0;
          if (Number.isFinite(e.latencyMs)) r.latencyMsSum += e.latencyMs;
        }
      }
      const dt = rec.frames[f];
      const fruitBefore = state.fruit;
      stats.beforeStep(state);
      step(state, dt, {
        decide: (point, s) => {
          if (point.actor !== 'pacman') return scripted.decide(point, s);
          const dir = moves.get(`${f}|${point.key}`)?.shift() ?? null;
          if (dir === null) return null;
          used += 1;
          if (!point.options.includes(dir) && illegal === null) illegal = `frame ${f}: ${dir} is not a way out of (${point.tile.x},${point.tile.y})`;
          return dir;
        },
      });
      if (illegal) return fail(illegal);
      stats.afterStep(state, dt);
      if (!fruitBefore && state.fruit) r.fruitSpawned += 1;
      if (state.status === 'playing') r.survived += dt;
    }
  } catch (err) {
    return fail(`the game could not be replayed: ${(err as Error).message}`);
  }
  if (state.status !== 'gameover' && r.survived < rules.maxSeconds - rules.maxStep) return fail('the game stops before game over or the time cap');
  if (used !== pacmanMoves) return fail(`${pacmanMoves - used} of Pac-Man's recorded moves were never asked for: the game went differently`);
  const claimed = rec.final;
  if (claimed?.score !== state.score || claimed.level !== state.level || claimed.lives !== state.lives || claimed.frames !== rec.frames.length) {
    return fail(`the replay ends at score ${state.score}, level ${state.level}, ${state.lives} lives; the recording claims score ${claimed?.score}, level ${claimed?.level}, ${claimed?.lives} lives`);
  }
  return { ok: true, result: finishResult(r, stats, state) };
}
