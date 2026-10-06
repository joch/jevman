import { describe, expect, it } from 'vitest';
import type { DecideResponse, SystemOneRequest } from '../src/brain';
import { Scheduler, type SchedulerEvent, type Transport } from '../src/scheduler';
import { REVERSE } from '../src/maze';
import { createGame, escapePoint, jevActors, nextDecisionPoint, type DecisionPoint, type GameState } from '../src/sim';
import type { ActorId, Dir } from '../src/types';
import type { ModelId } from '../shared/models';

interface Call {
  body: SystemOneRequest;
  resolve: (r: DecideResponse) => void;
  reject: (e: Error) => void;
}

function harness(opts: { maxInFlight?: number; actors?: readonly ActorId[] | ((s: GameState) => readonly ActorId[]); safetyCheck?: boolean; modelFor?: (actor: ActorId) => ModelId } = {}) {
  const calls: Call[] = [];
  const events: SchedulerEvent[] = [];
  const clock = { now: 0 };
  const transport: Transport = (body) => new Promise((resolve, reject) => calls.push({ body, resolve, reject }));
  const scheduler = new Scheduler({ transport, now: () => clock.now, onEvent: (e) => events.push(e), ...opts });
  return { calls, events, clock, scheduler };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function answerAll(body: SystemOneRequest, pick: (actor: string, options: string[]) => string = (_, o) => o[0]): DecideResponse {
  return {
    answers: Object.fromEntries(
      Object.entries(body.questions).map(([actor, q]) => {
        const options = Object.keys(q.criteria);
        const choice = pick(actor, options);
        const probabilities = Object.fromEntries(options.map((o) => [o, o === choice ? 0.9 : 0.1 / Math.max(1, options.length - 1)]));
        return [actor, { type: 'choice', choice, confidence: 0.9, probabilities }];
      }),
    ),
    usage: { input_tokens: 100, output_tokens: 10 },
    latencyMs: 300,
    costUsd: 0.00002,
    traceId: 'trace-1',
  };
}

const ofType = <T extends SchedulerEvent['type']>(events: SchedulerEvent[], type: T) =>
  events.filter((e): e is Extract<SchedulerEvent, { type: T }> => e.type === type);

describe('Scheduler', () => {
  it('batches every jev actor’s upcoming junction into one request', () => {
    const { calls, scheduler } = harness();
    scheduler.update(createGame());
    expect(calls).toHaveLength(1);
    expect(Object.keys(calls[0].body.questions).sort()).toEqual(['blinky', 'pacman']);
  });

  it('does not re-request a pending decision', () => {
    const { calls, scheduler } = harness();
    const s = createGame();
    scheduler.update(s);
    scheduler.update(s);
    expect(calls).toHaveLength(1);
  });

  it('serves jev answers once, at the matching junction', async () => {
    const { calls, events, scheduler } = harness();
    const s = createGame();
    scheduler.update(s);
    calls[0].resolve(answerAll(calls[0].body));
    await flush();
    const point = nextDecisionPoint(s, 'blinky')!;
    expect(scheduler.decide(point, s)).toBe(point.options[0]);
    expect(scheduler.decide(point, s)).toBeNull();
    const decisions = ofType(events, 'decision');
    expect(decisions).toHaveLength(2);
    expect(decisions.every((e) => e.decision.source === 'jev' && e.latencyMs === 300)).toBe(true);
    expect(ofType(events, 'call')[0]).toMatchObject({ costUsd: 0.00002, usage: { input_tokens: 100 } });
    expect(ofType(events, 'call')[0].costEstimated).toBe(false);
  });

  it('only remembers answered escape questions, not junctions, as consumed', async () => {
    const { calls, scheduler } = harness({ actors: ['blinky'] });
    const s = createGame();
    scheduler.update(s);
    calls[0].resolve(answerAll(calls[0].body));
    await flush();
    const point = nextDecisionPoint(s, 'blinky')!;
    expect(scheduler.decide(point, s)).toBe(point.options[0]);
    // A junction answer is not remembered once handed out: if the same junction is still ahead, it is asked again.
    scheduler.update(s);
    expect(calls).toHaveLength(2);
    expect(Object.keys(calls[1].body.questions)).toEqual(['blinky']);
  });

  it('asks about nobody in the classic game: the player against the scripted ghosts', () => {
    const { calls, scheduler } = harness({ actors: jevActors });
    scheduler.update(createGame({ pacmanControl: 'keyboard', ghostsByAI: false }));
    expect(calls).toHaveLength(0);
  });

  it('marks estimated costs on call events', async () => {
    const { calls, events, scheduler } = harness();
    scheduler.update(createGame());
    calls[0].resolve({ ...answerAll(calls[0].body), costEstimated: true });
    await flush();
    expect(ofType(events, 'call')[0].costEstimated).toBe(true);
  });

  it('limits batches in flight and sends queued questions later', async () => {
    const { calls, scheduler } = harness({ maxInFlight: 1 });
    const s = createGame();
    scheduler.update(s);
    Object.assign(s.ghosts.pinky, { state: 'normal', tile: { x: 13, y: 11 }, dir: 'left', progress: 0 });
    scheduler.update(s);
    expect(calls).toHaveLength(1);
    calls[0].resolve(answerAll(calls[0].body));
    await flush();
    scheduler.update(s);
    expect(calls).toHaveLength(2);
    expect(Object.keys(calls[1].body.questions)).toEqual(['pinky']);
  });

  it('falls back after the timeout and drops the late answer as stale', async () => {
    const { calls, events, clock, scheduler } = harness();
    const s = createGame();
    scheduler.update(s);
    clock.now = 2001;
    scheduler.update(s);
    const decisions = ofType(events, 'decision');
    expect(decisions.map((e) => [e.decision.source, e.decision.reason])).toEqual([
      ['fallback', 'timeout'],
      ['fallback', 'timeout'],
    ]);
    const point = nextDecisionPoint(s, 'blinky')!;
    expect(point.options).toContain(scheduler.decide(point, s));
    calls[0].resolve(answerAll(calls[0].body));
    await flush();
    expect(ofType(events, 'stale').map((e) => e.actor).sort()).toEqual(['blinky', 'pacman']);
  });

  it('falls back and reports the error when the transport fails', async () => {
    const { calls, events, scheduler } = harness();
    scheduler.update(createGame());
    calls[0].reject(new Error('jev 1.13 returned HTTP 529: overloaded'));
    await flush();
    expect(ofType(events, 'error')[0].message).toMatch(/529/);
    expect(ofType(events, 'decision').every((e) => e.decision.source === 'fallback' && e.decision.reason === 'error')).toBe(true);
  });

  it('falls back when jev picks an option that was not offered', async () => {
    const { calls, events, scheduler } = harness();
    scheduler.update(createGame());
    calls[0].resolve(answerAll(calls[0].body, (actor, o) => (actor === 'blinky' ? 'down' : o[0])));
    await flush();
    const blinky = ofType(events, 'decision').find((e) => e.decision.actor === 'blinky')!;
    expect(blinky.decision).toMatchObject({ source: 'fallback', reason: 'invalid answer' });
  });

  it('drops answers for a junction that is no longer relevant', async () => {
    const { calls, events, scheduler } = harness();
    const s = createGame();
    scheduler.update(s);
    s.pacman.epoch += 1; // e.g. Pac-Man was reset
    scheduler.update(s);
    expect(calls).toHaveLength(2);
    expect(Object.keys(calls[1].body.questions)).toEqual(['pacman']);
    calls[0].resolve(answerAll(calls[0].body));
    await flush();
    expect(ofType(events, 'stale').map((e) => e.actor)).toEqual(['pacman']);
    expect(ofType(events, 'decision').map((e) => e.decision.actor)).toEqual(['blinky']);
  });

  it('asks escape questions next to the junction question and never re-asks an answered one', async () => {
    const { calls, scheduler } = harness({ actors: ['pacman'], safetyCheck: false });
    const s = createGame();
    s.status = 'playing';
    Object.assign(s.pacman, { tile: { x: 10, y: 29 }, dir: 'left', progress: 0.5 });
    Object.assign(s.ghosts.blinky, { state: 'normal', tile: { x: 5, y: 29 }, dir: 'right', progress: 0 });
    scheduler.update(s);
    expect(Object.keys(calls[0].body.questions).sort()).toEqual(['pacman', 'pacman_escape']);
    calls[0].resolve(answerAll(calls[0].body));
    await flush();
    const escape = escapePoint(s)!;
    expect(scheduler.decide(escape, s)).toBe('left');
    scheduler.update(s);
    expect(calls).toHaveLength(1);
  });

  it('translates a turn-back answer to Pac-Man\'s heading after a corner', async () => {
    const { calls, scheduler } = harness({ actors: ['pacman'] });
    const s = createGame();
    s.status = 'playing';
    Object.assign(s.pacman, { tile: { x: 2, y: 29 }, dir: 'left', progress: 0 });
    Object.assign(s.ghosts.blinky, { state: 'normal', tile: { x: 1, y: 27 }, dir: 'down', progress: 0 });
    scheduler.update(s);
    calls[0].resolve(answerAll(calls[0].body, (actor, o) => (actor === 'pacman_escape' ? 'right' : o[0])));
    await flush();
    Object.assign(s.pacman, { tile: { x: 1, y: 28 }, dir: 'up', progress: 0 });
    expect(scheduler.decide(escapePoint(s)!, s)).toBe('down');
  });

  it('shares the in-flight cap between schedulers given the same slots (e.g. across restarts)', async () => {
    const calls: Call[] = [];
    const transport: Transport = (body) => new Promise((resolve, reject) => calls.push({ body, resolve, reject }));
    const slots = { inFlight: 0 };
    const first = new Scheduler({ transport, now: () => 0, onEvent: () => {}, maxInFlight: 1, slots });
    first.update(createGame());
    expect(calls).toHaveLength(1);
    const second = new Scheduler({ transport, now: () => 0, onEvent: () => {}, maxInFlight: 1, slots });
    second.update(createGame());
    expect(calls).toHaveLength(1); // the first game's request still holds the only slot
    calls[0].resolve(answerAll(calls[0].body));
    await flush();
    second.update(createGame());
    expect(calls).toHaveLength(2);
  });

  it('only asks about the actors it is limited to', () => {
    const { calls, scheduler } = harness({ actors: ['pacman'] });
    scheduler.update(createGame());
    expect(Object.keys(calls[0].body.questions)).toEqual(['pacman']);
  });

  it('stops asking about Pac-Man in keyboard mode', () => {
    const { calls, scheduler } = harness();
    scheduler.update(createGame({ pacmanControl: 'keyboard' }));
    expect(Object.keys(calls[0].body.questions)).toEqual(['blinky']);
  });

  it('forgets everything on reset', async () => {
    const { calls, scheduler } = harness();
    const s = createGame();
    scheduler.update(s);
    calls[0].resolve(answerAll(calls[0].body));
    await flush();
    scheduler.reset();
    expect(scheduler.decide(nextDecisionPoint(s, 'blinky')!, s)).toBeNull();
  });
});

describe('Scheduler and fruit', () => {
  const cherry = () => ({ kind: 'cherry' as const, points: 100, tile: { x: 13, y: 17 }, secondsLeft: 9 });

  it('re-asks Pac-Man when fruit appears while his question is pending', async () => {
    const { calls, events, scheduler } = harness({ actors: ['pacman'] });
    const s = createGame();
    scheduler.update(s);
    expect(JSON.stringify(calls[0].body.questions.pacman.criteria)).not.toContain('FRUIT');
    s.fruit = cherry();
    scheduler.update(s);
    expect(calls).toHaveLength(2);
    expect(JSON.stringify(calls[1].body.questions.pacman.criteria)).toContain('FRUIT');
    calls[0].resolve(answerAll(calls[0].body));
    await flush();
    expect(ofType(events, 'stale').map((e) => e.actor)).toEqual(['pacman']);
  });

  it('drops a ready answer made with fruit on the board once the fruit is gone', async () => {
    const { calls, events, scheduler } = harness({ actors: ['pacman'] });
    const s = createGame();
    s.fruit = cherry();
    scheduler.update(s);
    calls[0].resolve(answerAll(calls[0].body));
    await flush();
    s.fruit = null;
    scheduler.update(s);
    expect(ofType(events, 'superseded')).toHaveLength(1);
    expect(scheduler.decide(nextDecisionPoint(s, 'pacman')!, s)).toBeNull();
    expect(calls).toHaveLength(2);
  });

  it('answers with fruit-aware fallback rules when fruit appears in the same step Pac-Man reaches the junction', async () => {
    const { calls, events, scheduler } = harness({ actors: ['pacman'] });
    const s = createGame();
    scheduler.update(s);
    calls[0].resolve(answerAll(calls[0].body));
    await flush();
    s.fruit = cherry(); // spawned inside sim.step, before the next scheduler.update
    const point = nextDecisionPoint(s, 'pacman')!;
    expect(scheduler.decide(point, s)).not.toBeNull();
    expect(ofType(events, 'decision').at(-1)!.decision).toMatchObject({ source: 'fallback', reason: 'fruit changed' });
  });

  it('keeps a fruit-aware answer while the fruit is still reachable, but not once it drifts out of reach', async () => {
    for (const secondsLeft of [8, 0.2]) {
      const { calls, events, scheduler } = harness({ actors: ['pacman'] });
      const s = createGame();
      s.fruit = cherry();
      scheduler.update(s);
      calls[0].resolve(answerAll(calls[0].body));
      await flush();
      s.fruit.secondsLeft = secondsLeft; // Pac-Man waited at the junction for the answer
      expect(scheduler.decide(nextDecisionPoint(s, 'pacman')!, s)).not.toBeNull();
      expect(ofType(events, 'decision').at(-1)!.decision.source).toBe(secondsLeft === 8 ? 'jev' : 'fallback');
      expect(ofType(events, 'superseded')).toHaveLength(secondsLeft === 8 ? 0 : 1);
    }
  });
});

describe('Scheduler safety check', () => {
  it('replaces a jev pick that ghosts made unsafe with the safe option jev rated highest', async () => {
    const { calls, events, scheduler } = harness({ actors: ['pacman'] });
    const s = createGame();
    s.status = 'playing';
    Object.assign(s.pacman, { tile: { x: 10, y: 29 }, dir: 'left', progress: 0.5 });
    Object.assign(s.ghosts.blinky, { state: 'normal', tile: { x: 5, y: 29 }, dir: 'right', progress: 0 });
    scheduler.update(s);
    calls[0].resolve(answerAll(calls[0].body)); // "keep going left", into Blinky
    await flush();
    expect(scheduler.decide(escapePoint(s)!, s)).toBe('right');
    expect(ofType(events, 'superseded')).toHaveLength(0);
    expect(ofType(events, 'decision').at(-1)!.decision).toMatchObject({ source: 'jev', choice: 'right', vetoed: 'left' });
  });

  const ghostInto = (s: GameState, point: DecisionPoint, dir: Dir) => {
    const tile = s.maze.neighbor(s.maze.neighbor(point.tile, dir), dir);
    Object.assign(s.ghosts.blinky, { state: 'normal', tile, dir: REVERSE[dir], progress: 0, waiting: false });
  };

  it('vetoes a junction pick when a ghost has since moved into that corridor', async () => {
    const { calls, events, scheduler } = harness({ actors: ['pacman'] });
    const s = createGame();
    scheduler.update(s);
    calls[0].resolve(answerAll(calls[0].body));
    await flush();
    const point = nextDecisionPoint(s, 'pacman')!;
    const picked = point.options[0];
    ghostInto(s, point, picked);
    const choice = scheduler.decide(point, s);
    expect(choice).not.toBe(picked);
    expect(ofType(events, 'decision').at(-1)!.decision).toMatchObject({ source: 'jev', choice, vetoed: picked });
  });

  it('never second-guesses a fallback decision', async () => {
    const { clock, events, scheduler } = harness({ actors: ['pacman'] });
    const s = createGame();
    scheduler.update(s);
    clock.now = 2001;
    scheduler.update(s); // times out to the greedy rule
    const point = nextDecisionPoint(s, 'pacman')!;
    const fallback = ofType(events, 'decision').at(-1)!.decision;
    expect(fallback.source).toBe('fallback');
    ghostInto(s, point, fallback.choice);
    expect(scheduler.decide(point, s)).toBe(fallback.choice);
    expect(ofType(events, 'decision').some((e) => e.decision.vetoed)).toBe(false);
  });

  it('keeps a jev pick that is still safe', async () => {
    const { calls, events, scheduler } = harness({ actors: ['pacman'] });
    const s = createGame();
    scheduler.update(s);
    calls[0].resolve(answerAll(calls[0].body));
    await flush();
    const point = nextDecisionPoint(s, 'pacman')!;
    expect(scheduler.decide(point, s)).toBe(point.options[0]);
    expect(ofType(events, 'superseded')).toHaveLength(0);
  });
});

describe('jev plays one side', () => {
  it('asks about Pac-Man only while jev plays him, and about the ghosts only while the player steers', () => {
    const { calls, scheduler } = harness({ actors: jevActors });
    const s = createGame({ pacmanControl: 'jev' });
    scheduler.update(s);
    expect(Object.keys(calls[0].body.questions)).toEqual(['pacman']);
    s.pacmanControl = 'keyboard';
    scheduler.update(s);
    expect(Object.keys(calls[1].body.questions)).toEqual(['blinky']);
  });
});

describe('a model per character', () => {
  it('asks each model about its own characters in separate requests and tags answers with the model', async () => {
    const { calls, events, scheduler } = harness({ modelFor: (a) => (a === 'pacman' ? 'opper/kev-4b' : 'typesafe/jev-1.13.0') });
    scheduler.update(createGame());
    expect(calls.map((c) => [c.body.model, Object.keys(c.body.questions).sort()])).toEqual([
      ['opper/kev-4b', ['pacman']],
      ['typesafe/jev-1.13.0', ['blinky']],
    ]);
    for (const c of calls) c.resolve(answerAll(c.body));
    await flush();
    expect(ofType(events, 'call').map((e) => e.model).sort()).toEqual(['opper/kev-4b', 'typesafe/jev-1.13.0']);
    const byActor = Object.fromEntries(ofType(events, 'decision').map((e) => [e.decision.actor, e.decision.model]));
    expect(byActor).toEqual({ pacman: 'opper/kev-4b', blinky: 'typesafe/jev-1.13.0' });
  });

  it('names no model unless one was chosen, so the server default (JEV_MODEL or jev) applies', async () => {
    const one = harness();
    one.scheduler.update(createGame());
    expect(one.calls.map((c) => c.body.model)).toEqual([undefined]);
    one.calls[0].resolve({ ...answerAll(one.calls[0].body), model: 'opper/clef' });
    await flush();
    expect(ofType(one.events, 'decision').map((e) => e.decision.model)).toEqual(['opper/clef', 'opper/clef']);
  });

  it('sends the waiting model next when a slot frees up, so no model starves', async () => {
    const { calls, scheduler } = harness({ maxInFlight: 1, modelFor: (a) => (a === 'pacman' ? 'opper/kev-4b' : 'opper/clef') });
    const s = createGame();
    scheduler.update(s);
    expect(calls.map((c) => c.body.model)).toEqual(['opper/kev-4b']);
    calls[0].resolve(answerAll(calls[0].body));
    await flush();
    scheduler.update(s);
    expect(calls.map((c) => c.body.model)).toEqual(['opper/kev-4b', 'opper/clef']);
  });
});

describe('switching models mid-game', () => {
  it('drops an answer from the old model, ready or in flight, and asks the new one', async () => {
    let model: ModelId = 'opper/clef';
    const { calls, events, scheduler } = harness({ actors: ['pacman'], modelFor: () => model });
    const s = createGame();
    scheduler.update(s);
    calls[0].resolve(answerAll(calls[0].body));
    await flush();
    model = 'opper/kev-4b'; // a card switched Pac-Man to Kev 4B
    scheduler.update(s);
    expect(ofType(events, 'superseded')).toHaveLength(1);
    expect(calls.map((c) => c.body.model)).toEqual(['opper/clef', 'opper/kev-4b']);
    expect(scheduler.decide(nextDecisionPoint(s, 'pacman')!, s)).toBeNull();
    // Switch again while Kev's answer is in flight: it arrives stale.
    model = 'opper/clef-flash';
    scheduler.update(s);
    calls[1].resolve(answerAll(calls[1].body));
    await flush();
    expect(ofType(events, 'stale')).toHaveLength(1);
    expect(calls.at(-1)!.body.model).toBe('opper/clef-flash');
  });
});

