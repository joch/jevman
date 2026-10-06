// Replays a submitted game and recomputes its result. The game is deterministic: the recorded steps and Pac-Man's
// recorded moves, with the ghosts on the scripted rule, must give the recorded game, or the submission is refused.
// Pac-Man's moves must also be ones the bench's scheduler could have made: each escape question answered once while
// it is open, and no answer later than a model call can take.
import { createHash } from 'node:crypto';
import type { Recording } from '../src/replay';
import type { SchedulerEvent } from '../src/scheduler';
import { createGame, decisionPoints, step } from '../src/sim';
import { GameStats } from '../src/stats';
import { GHOST_IDS, type Dir } from '../src/types';
import { SUBMISSION_RULES, type GameResult, type SubmissionRules } from '../shared/leaderboard';
import { emptyResult, finishResult, scriptedControls } from './game';

export type Verdict =
  | {
      ok: true;
      result: GameResult;
      /**
       * Identifies the game played, not the file: where everyone was at each of Pac-Man's moves. Two recordings with
       * the same fingerprint replay to the same game, however their step timings differ.
       */
      fingerprint: string;
    }
  | { ok: false; error: string };

const DIRS = new Set<unknown>(['up', 'down', 'left', 'right']);

/** The bench's setTimeout-paced loop never steps less than this. */
export const MIN_STEP = 0.001;
/**
 * Game time a question can stay unanswered in a bench run. The scheduler falls back 2 s after sending a question, and
 * sends it at once unless all its slots are busy; every call gives up after 2 s, so a slot frees within 2 s. Game
 * time never runs ahead of the clock (a step is at most the real time since the last one). 2 + 2 s, plus room for
 * the frame the fallback lands in.
 */
export const MAX_ANSWER_SECONDS = 4.5;
/** Far above any real call: one decision costs fractions of a cent and gives up after seconds. */
const MAX_CALL_USD = 1;
const MAX_CALL_MS = 60_000;
/** Far more than a 300 s game has (a few thousand decisions and events); a bigger file is not a bench recording. */
const MAX_ITEMS = 100_000;

export function verifyGame(rec: Recording, rules: SubmissionRules = SUBMISSION_RULES): Verdict {
  const fail = (error: string): Verdict => ({ ok: false, error });
  if (rec?.version !== 1) return fail('not a version 1 recording');
  if (!Array.isArray(rec.frames) || !Array.isArray(rec.decisions) || !Array.isArray(rec.events)) return fail('frames, decisions and events must be lists');
  // Playing time is capped; the pauses around it (ready, dying, level clear) add well under two minutes.
  if (rec.frames.length > (rules.maxSeconds + 120) / MIN_STEP) return fail(`${rec.frames.length} frames is more than a game has`);
  if (rec.decisions.length > MAX_ITEMS || rec.events.length > MAX_ITEMS) return fail('more decisions or events than a game has');
  const badStep = rec.frames.findIndex((dt) => typeof dt !== 'number' || !(dt >= MIN_STEP) || dt > rules.maxStep);
  if (badStep >= 0) return fail(`frame ${badStep}: a step must be ${MIN_STEP} to ${rules.maxStep} s`);

  // Only Pac-Man's moves come from the recording; the ghosts play by the scripted rule, as in every benchmark game.
  const moves = new Map<string, Dir[]>();
  let pacmanMoves = 0;
  for (const d of rec.decisions) {
    if (!Array.isArray(d) || !Number.isInteger(d[0]) || typeof d[1] !== 'string' || !DIRS.has(d[2])) return fail('malformed decision');
    // Junction keys are pacman@…, escape keys pacman~…; the ghosts' keys start with their names.
    if (!/^pacman[@~]/.test(d[1])) continue;
    const k = `${d[0]}|${d[1]}`;
    const queue = moves.get(k);
    if (queue) queue.push(d[2]);
    else moves.set(k, [d[2]]);
    pacmanMoves += 1;
  }
  const events = new Map<number, SchedulerEvent[]>();
  for (const e of rec.events) {
    if (!Array.isArray(e) || !Number.isInteger(e[0]) || typeof e[1]?.type !== 'string') return fail('malformed event');
    // Within reason, so no sum of them can overflow (1e400 even parses to Infinity) and reach the leaderboard as null.
    const within = (v: unknown, max: number) => typeof v === 'number' && v >= 0 && v <= max;
    if (e[1].type === 'call' && !((e[1].costUsd === null || within(e[1].costUsd, MAX_CALL_USD)) && within(e[1].latencyMs, MAX_CALL_MS))) {
      return fail('a call with a negative or impossible cost or latency');
    }
    const event = (e[1].type === 'call' ? { ...e[1], traceId: null } : e[1]) as SchedulerEvent;
    const list = events.get(e[0]);
    if (list) list.push(event);
    else events.set(e[0], [event]);
  }

  const state = createGame();
  const stats = new GameStats();
  const r = emptyResult();
  const scripted = scriptedControls();
  let used = 0;
  let illegal: string | null = null;
  let clock = 0;
  /** When each of Pac-Man's open questions was first seen, and the escape questions already answered (as the scheduler keeps them). */
  const firstSeen = new Map<string, number>();
  const answered = new Set<string>();
  const fingerprint = createHash('sha256');
  // To 1/100 tile: honest real-time games that make the same moves are still tens of milliseconds apart.
  const at = (a: { tile: { x: number; y: number }; progress: number }) => [a.tile.x, a.tile.y, Math.round(a.progress * 100)];
  try {
    for (let f = 0; f < rec.frames.length; f++) {
      if (state.status === 'gameover') return fail(`frames go on after game over (frame ${f})`);
      if (r.survived >= rules.maxSeconds) return fail(`frames go on past the ${rules.maxSeconds} s cap (frame ${f})`);
      // Like the scheduler's update before each step: questions that closed are forgotten.
      const open = new Set(decisionPoints(state, 'pacman').map((p) => p.key));
      for (const key of open) if (!firstSeen.has(key)) firstSeen.set(key, clock);
      for (const key of firstSeen.keys()) if (!open.has(key)) firstSeen.delete(key);
      for (const key of answered) if (!open.has(key)) answered.delete(key);
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
          if (illegal !== null) return dir;
          if (!point.options.includes(dir)) illegal = `frame ${f}: ${dir} is not a way out of (${point.tile.x},${point.tile.y})`;
          // The scheduler only knows the questions open when it updated, before the step.
          else if (!firstSeen.has(point.key)) illegal = `frame ${f}: an answer to a question that was not open yet`;
          else if (point.escape && answered.has(point.key)) illegal = `frame ${f}: an escape question answered twice`;
          else if (clock - firstSeen.get(point.key)! > MAX_ANSWER_SECONDS) illegal = `frame ${f}: an answer after more than ${MAX_ANSWER_SECONDS} s`;
          if (point.escape) answered.add(point.key);
          fingerprint.update(JSON.stringify([point.key, dir, at(s.pacman), ...GHOST_IDS.map((id) => [...at(s.ghosts[id]), s.ghosts[id].state])]));
          return dir;
        },
      });
      if (illegal) return fail(illegal);
      stats.afterStep(state, dt);
      if (!fruitBefore && state.fruit) r.fruitSpawned += 1;
      if (state.status === 'playing') r.survived += dt;
      clock += dt;
    }
  } catch (err) {
    return fail(`the game could not be replayed: ${(err as Error).message}`);
  }
  // The bench plays on until game over or until the cap is reached, adding the same rounded steps in the same order.
  if (state.status !== 'gameover' && r.survived < rules.maxSeconds) return fail('the game stops before game over or the time cap');
  if (used !== pacmanMoves) return fail(`${pacmanMoves - used} of Pac-Man's recorded moves were never asked for: the game went differently`);
  const claimed = rec.final;
  if (claimed?.score !== state.score || claimed.level !== state.level || claimed.lives !== state.lives || claimed.frames !== rec.frames.length) {
    return fail(`the replay ends at score ${state.score}, level ${state.level}, ${state.lives} lives; the recording claims score ${claimed?.score}, level ${claimed?.level}, ${claimed?.lives} lives`);
  }
  return { ok: true, result: finishResult(r, stats, state), fingerprint: fingerprint.digest('hex') };
}
