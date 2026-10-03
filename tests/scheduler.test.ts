import { describe, expect, it } from 'vitest';
import type { DecideResponse, SystemOneRequest } from '../src/brain';
import { Scheduler, type SchedulerEvent, type Transport } from '../src/scheduler';
import { createGame, escapePoint, nextDecisionPoint } from '../src/sim';
import type { ActorId } from '../src/types';

interface Call {
  body: SystemOneRequest;
  resolve: (r: DecideResponse) => void;
  reject: (e: Error) => void;
}

function harness(opts: { maxInFlight?: number; actors?: readonly ActorId[] } = {}) {
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
    expect(scheduler.decide(point)).toBe(point.options[0]);
    expect(scheduler.decide(point)).toBeNull();
    const decisions = ofType(events, 'decision');
    expect(decisions).toHaveLength(2);
    expect(decisions.every((e) => e.decision.source === 'jev' && e.latencyMs === 300)).toBe(true);
    expect(ofType(events, 'call')[0]).toMatchObject({ costUsd: 0.00002, usage: { input_tokens: 100 } });
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
    expect(point.options).toContain(scheduler.decide(point));
    calls[0].resolve(answerAll(calls[0].body));
    await flush();
    expect(ofType(events, 'stale').map((e) => e.actor).sort()).toEqual(['blinky', 'pacman']);
  });

  it('falls back and reports the error when the transport fails', async () => {
    const { calls, events, scheduler } = harness();
    scheduler.update(createGame());
    calls[0].reject(new Error('jev returned HTTP 529: overloaded'));
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
    const { calls, scheduler } = harness({ actors: ['pacman'] });
    const s = createGame();
    s.status = 'playing';
    Object.assign(s.pacman, { tile: { x: 10, y: 29 }, dir: 'left', progress: 0.5 });
    Object.assign(s.ghosts.blinky, { state: 'normal', tile: { x: 5, y: 29 }, dir: 'right', progress: 0 });
    scheduler.update(s);
    expect(Object.keys(calls[0].body.questions).sort()).toEqual(['pacman', 'pacman_escape']);
    calls[0].resolve(answerAll(calls[0].body));
    await flush();
    const escape = escapePoint(s)!;
    expect(scheduler.decide(escape)).toBe('left');
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
    expect(scheduler.decide(escapePoint(s)!)).toBe('down');
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
    expect(scheduler.decide(nextDecisionPoint(s, 'blinky')!)).toBeNull();
  });
});
