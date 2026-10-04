import { describe, expect, it } from 'vitest';
import { GameStats, deathContext, deathLabel } from '../src/stats';
import { createGame, DYING_SECONDS, step, type Controls, type GameState } from '../src/sim';
import { GHOST_IDS } from '../src/types';

const never: Controls = { decide: () => null };

function playing(): GameState {
  const s = createGame({ pacmanControl: 'keyboard' });
  s.status = 'playing';
  s.statusTimer = 0;
  for (const id of GHOST_IDS) {
    s.ghosts[id].state = 'house';
    s.ghosts[id].releaseAt = Infinity;
  }
  return s;
}

/** Steps like the game loop does, with the tracker around each step. */
function run(stats: GameStats, s: GameState, seconds: number, ctl: Controls = never) {
  for (let t = 0; t < seconds - 1e-9; t += 1 / 60) {
    stats.beforeStep(s);
    step(s, 1 / 60, ctl);
    stats.afterStep(s, 1 / 60);
  }
}

describe('GameStats', () => {
  it('counts time only while playing, plus pellets, score and level', () => {
    const s = createGame({ pacmanControl: 'keyboard' });
    for (const id of GHOST_IDS) s.ghosts[id].releaseAt = Infinity;
    s.ghosts.blinky.state = 'house';
    const stats = new GameStats();
    run(stats, s, 2); // 1.5 s READY, then 0.5 s of play
    const sum = stats.summary(s);
    expect(sum.seconds).toBeCloseTo(0.5, 1);
    expect(sum.pellets).toBe(3);
    expect(sum.score).toBe(30);
    expect(sum.level).toBe(1);
  });

  it('counts ghosts and fruit eaten', () => {
    const s = playing();
    const stats = new GameStats();
    s.fruit = { kind: 'cherry', points: 100, tile: { x: 12, y: 23 }, secondsLeft: 5 };
    run(stats, s, 0.14);
    expect(stats.summary(s).fruit).toEqual([{ kind: 'cherry', points: 100 }]);

    Object.assign(s.pacman, { tile: { x: 3, y: 23 }, dir: 'left', progress: 0 });
    run(stats, s, 0.27); // eats the power pellet at (1,23)
    for (const id of ['blinky', 'pinky'] as const) {
      Object.assign(s.ghosts[id], { state: 'frightened', tile: { x: 1, y: 23 }, dir: 'up', progress: 0, waiting: false });
    }
    run(stats, s, 1 / 60);
    expect(stats.summary(s).ghostsEaten).toBe(2);
  });

  it('does not count fruit that expires uneaten', () => {
    const s = playing();
    const stats = new GameStats();
    s.fruit = { kind: 'cherry', points: 100, tile: { x: 13, y: 17 }, secondsLeft: 0.05 };
    run(stats, s, 0.2);
    expect(stats.summary(s).fruit).toEqual([]);
  });

  it('records who caught Pac-Man and in what situation', () => {
    const s = playing();
    const stats = new GameStats();
    Object.assign(s.ghosts.blinky, { state: 'normal', tile: { x: 10, y: 23 }, dir: 'right', progress: 0 });
    run(stats, s, 0.3);
    run(stats, s, DYING_SECONDS + 0.05);
    const { deaths } = stats.summary(s);
    expect(deaths).toHaveLength(1);
    expect(deaths[0]).toMatchObject({ ghost: 'blinky', context: 'ghost ahead in corridor' });
    expect(deathLabel(deaths[0])).toBe('ran into Blinky in a corridor');
    expect(s.lives).toBe(2);
  });

  it('aggregates jev calls, decisions, fallbacks, latency, confidence and cost', () => {
    const stats = new GameStats();
    const call = { type: 'call' as const, actors: ['blinky' as const], usage: { input_tokens: 1, output_tokens: 1 }, traceId: null };
    stats.onSchedulerEvent({ ...call, latencyMs: 200, costUsd: 0.00004 });
    stats.onSchedulerEvent({ ...call, latencyMs: 300, costUsd: 0.00006, costEstimated: true });
    const decision = (source: 'jev' | 'fallback', confidence: number | null) => ({
      type: 'decision' as const,
      latencyMs: 200,
      fruitOnBoard: false,
      decision: { actor: 'blinky' as const, key: 'k', tile: { x: 0, y: 0 }, choice: 'up' as const, options: ['up' as const], probabilities: {}, confidence, source },
    });
    stats.onSchedulerEvent(decision('jev', 0.8));
    stats.onSchedulerEvent(decision('jev', 0.6));
    stats.onSchedulerEvent(decision('fallback', null));
    expect(stats.summary(createGame()).jev).toEqual({
      calls: 2,
      decisions: 3,
      fallbacks: 1,
      meanLatencyMs: 250,
      meanConfidence: 0.7,
      costUsd: 0.0001,
      costEstimated: true,
      errors: 0,
    });
  });

  it('classifies a death while Pac-Man waits for jev', () => {
    const s = playing();
    s.pacman.waiting = true;
    expect(deathContext(s)).toBe('waiting at junction');
    expect(deathLabel({ ghost: 'inky', context: 'waiting at junction', seconds: 0 })).toBe('caught by Inky while waiting for jev at a junction');
  });
});

describe('summaryRows', () => {
  it('formats the game-over numbers', async () => {
    const { summaryRows } = await import('../src/overlay');
    const rows = summaryRows({
      score: 3500, level: 2, seconds: 84.4, pellets: 234, ghostsEaten: 3,
      fruit: [{ kind: 'cherry', points: 100 }, { kind: 'strawberry', points: 300 }],
      deaths: [],
      jev: { calls: 487, decisions: 560, fallbacks: 2, meanLatencyMs: 252, meanConfidence: 0.71, costUsd: 0.02301, costEstimated: true, errors: 0 },
    });
    expect(rows.game).toEqual([['Level', '2'], ['Time', '1:24'], ['Pellets', '234'], ['Ghosts eaten', '3'], ['Fruit', '🍒 🍓']]);
    expect(rows.jev).toEqual([['Calls', '487'], ['Decisions', '560'], ['Fallbacks', '2'], ['Mean latency', '252 ms'], ['Avg confidence', '71%'], ['Cost', '≈$0.0230']]);
  });

  it('shows dashes when nothing happened', async () => {
    const { summaryRows } = await import('../src/overlay');
    const rows = summaryRows({ score: 0, level: 1, seconds: 3, pellets: 0, ghostsEaten: 0, fruit: [], deaths: [], jev: { calls: 0, decisions: 0, fallbacks: 0, meanLatencyMs: null, meanConfidence: null, costUsd: null, costEstimated: false, errors: 3 } });
    expect(rows.game.find(([k]) => k === 'Fruit')![1]).toBe('–');
    expect(rows.jev.slice(3)).toEqual([['Mean latency', '–'], ['Avg confidence', '–'], ['Cost', '–'], ['Failed calls', '3']]);
  });
});

describe('GameStats edge cases', () => {
  it('counts ghosts eaten right after a new power pellet even when the old chain was the same length', () => {
    const s = playing();
    const stats = new GameStats();
    s.frightChain = 2; // left over from an earlier fright
    Object.assign(s.pacman, { tile: { x: 2, y: 23 }, dir: 'left', progress: 0.9 });
    for (const id of ['blinky', 'pinky'] as const) {
      Object.assign(s.ghosts[id], { state: 'normal', tile: { x: 1, y: 22 }, dir: 'down', progress: 0.9, waiting: false });
    }
    run(stats, s, 1 / 60); // eats the power pellet at (1,23) and both ghosts in the same step
    expect(s.frightChain).toBe(2);
    expect(stats.summary(s).ghostsEaten).toBe(2);
  });

  it('counts failed calls and reports unknown cost and latency honestly', () => {
    const stats = new GameStats();
    stats.onSchedulerEvent({ type: 'error', message: 'Your Opper wallet is empty' });
    stats.onSchedulerEvent({ type: 'call', actors: ['blinky'], usage: { input_tokens: 1, output_tokens: 1 }, traceId: null, latencyMs: Number.NaN, costUsd: null });
    stats.onSchedulerEvent({ type: 'call', actors: ['blinky'], usage: { input_tokens: 1, output_tokens: 1 }, traceId: null, latencyMs: 300, costUsd: null });
    expect(stats.summary(createGame()).jev).toMatchObject({ calls: 2, errors: 1, meanLatencyMs: 300, costUsd: null });
  });
});
