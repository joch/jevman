import { describe, expect, it } from 'vitest';
import { buildRequest, fallbackDecision, instructionsFor, parseAnswer, summarizeState, type PendingQuestion } from '../src/brain';
import { optionFeatures } from '../src/features';
import { createGame, nextDecisionPoint, type GameState } from '../src/sim';
import type { ActorId } from '../src/types';

const pending = (s: GameState, id: ActorId): PendingQuestion => {
  const point = nextDecisionPoint(s, id)!;
  return { point, features: optionFeatures(s, point) };
};

describe('buildRequest', () => {
  it('asks one choice question per actor with only legal options', () => {
    const s = createGame();
    s.mode = 'chase';
    const body = buildRequest(s, [pending(s, 'pacman'), pending(s, 'blinky')]);
    expect(Object.keys(body.questions).sort()).toEqual(['blinky', 'pacman']);
    expect(body.questions.pacman.type).toBe('choice');
    expect(Object.keys(body.questions.pacman.criteria).sort()).toEqual(['left', 'right', 'up']);
    expect(Object.keys(body.questions.blinky.criteria).sort()).toEqual(['left', 'up']);
    expect(body.questions.blinky.criteria.left).toMatch(/^Go left: Pac-Man \d+ steps away via this route/);
    expect(body.questions.pacman.criteria.left).toMatch(/nearest pellet 1 steps away/);
  });

  it('summarises the board for jev', () => {
    const s = createGame();
    s.maze.pellets.delete(s.maze.key({ x: 1, y: 1 }));
    const summary = summarizeState(s) as { maze: string[]; pellets_left: number; fruit: unknown };
    expect(summary.maze).toHaveLength(31);
    expect(summary.maze.every((row) => row.length === 28)).toBe(true);
    expect(summary.maze[23][13]).toBe('P');
    expect(summary.maze[11][13]).toBe('B');
    expect(summary.maze[1][1]).toBe(' ');
    expect(summary.pellets_left).toBe(243);
    expect(summary.fruit).toBeNull();
  });
});

describe('instructionsFor', () => {
  it('reflects personality, mode, fright and fruit', () => {
    const s = createGame();
    s.mode = 'chase';
    expect(instructionsFor(s, nextDecisionPoint(s, 'blinky')!)).toMatch(/Blinky/);
    s.mode = 'scatter';
    expect(instructionsFor(s, nextDecisionPoint(s, 'blinky')!)).toMatch(/home corner/);
    s.ghosts.blinky.state = 'frightened';
    s.frightLeft = 4;
    expect(instructionsFor(s, nextDecisionPoint(s, 'blinky')!)).toMatch(/Flee/);
    expect(instructionsFor(s, nextDecisionPoint(s, 'pacman')!)).toMatch(/Hunt/);
    s.fruit = { kind: 'cherry', points: 100, tile: { x: 13, y: 17 }, secondsLeft: 8 };
    expect(instructionsFor(s, nextDecisionPoint(s, 'pacman')!)).toMatch(/cherry worth 100 points/);
  });
});

describe('parseAnswer', () => {
  const s = createGame();
  const q = pending(s, 'blinky');

  it('turns a valid choice into a jev decision with probabilities for offered options', () => {
    const d = parseAnswer(
      { type: 'choice', choice: 'up', confidence: 0.8, probabilities: { up: 0.8, left: 0.2, down: 0 } },
      q,
    )!;
    expect(d).toMatchObject({ actor: 'blinky', choice: 'up', confidence: 0.8, source: 'jev', key: q.point.key });
    expect(d.probabilities).toEqual({ up: 0.8, left: 0.2 });
  });

  it('rejects choices that were not offered and malformed answers', () => {
    expect(parseAnswer({ type: 'choice', choice: 'right', confidence: 1, probabilities: {} }, q)).toBeNull();
    expect(parseAnswer(null, q)).toBeNull();
    expect(parseAnswer({ type: 'score', score: 3 }, q)).toBeNull();
  });

  it('builds a tagged greedy fallback', () => {
    const d = fallbackDecision(s, q, 'timeout');
    expect(d.source).toBe('fallback');
    expect(d.reason).toBe('timeout');
    expect(q.point.options).toContain(d.choice);
  });
});
