import { describe, expect, it } from 'vitest';
import { buildRequest, fallbackDecision, instructionsFor, parseAnswer, questionName, summarizeState, type PendingQuestion } from '../src/brain';
import { optionFeatures } from '../src/features';
import { createGame, escapePoint, nextDecisionPoint, type GameState } from '../src/sim';
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
    expect(body.questions.pacman.criteria.left).toMatch(/nearest pellet 1 step away/);
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

describe('Pac-Man danger criteria', () => {
  it('describes power pellets, approaching ghosts, crowds and traps', () => {
    const s = createGame();
    for (const id of ['pinky', 'inky', 'clyde'] as const) s.ghosts[id].releaseAt = Infinity;
    s.ghosts.blinky.state = 'house';
    Object.assign(s.ghosts.pinky, { state: 'normal', tile: { x: 9, y: 26 }, dir: 'up', progress: 0 });
    Object.assign(s.ghosts.inky, { state: 'normal', tile: { x: 6, y: 21 }, dir: 'down', progress: 0 });
    const { criteria } = buildRequest(s, [pending(s, 'pacman')]).questions.pacman;
    expect(criteria.left).toMatch(/power pellet 17 steps away/);
    expect(criteria.left).toMatch(/nearest dangerous ghost \d+ steps away, coming toward you/);
    expect(criteria.left).toMatch(/2 dangerous ghosts within 8 steps/);
    expect(criteria.left).toMatch(/TRAP: Pinky can reach the next junction in 3 steps, you need 4/);
    expect(criteria.right).toMatch(/you reach the next junction in 4 steps, \d+ steps before any ghost/);
  });
});

describe('escape questions', () => {
  it('asks a separately named turn-back question and tags the decision as an escape', () => {
    const s = createGame();
    s.status = 'playing';
    Object.assign(s.pacman, { tile: { x: 10, y: 29 }, dir: 'left', progress: 0.5 });
    Object.assign(s.ghosts.blinky, { state: 'normal', tile: { x: 5, y: 29 }, dir: 'right', progress: 0 });
    const point = escapePoint(s)!;
    const q = { point, features: optionFeatures(s, point) };
    expect(questionName(point)).toBe('pacman_escape');
    const body = buildRequest(s, [q]);
    expect(Object.keys(body.questions)).toEqual(['pacman_escape']);
    expect(body.questions.pacman_escape.instructions).toMatch(/Blinky is in the corridor ahead or can block the junction.*turn back right/);
    const d = parseAnswer({ type: 'choice', choice: 'right', confidence: 0.9, probabilities: { right: 0.9, left: 0.1 } }, q)!;
    expect(d).toMatchObject({ choice: 'right', escape: true });
    expect(fallbackDecision(s, q, 'timeout').escape).toBe(true);
  });
});

describe('fruit in the prompt', () => {
  it('marks only the fastest safe route to reachable fruit and says to take it', () => {
    const s = createGame();
    for (const id of ['pinky', 'inky', 'clyde'] as const) s.ghosts[id].releaseAt = Infinity;
    s.ghosts.blinky.state = 'house';
    s.fruit = { kind: 'cherry', points: 100, tile: { x: 13, y: 17 }, secondsLeft: 9 };
    const { instructions, criteria } = buildRequest(s, [pending(s, 'pacman')]).questions.pacman;
    const marked = Object.entries(criteria).filter(([, v]) => v.includes('FRUIT'));
    expect(marked).toHaveLength(1);
    expect(marked[0][1]).toMatch(/^Go \w+: FRUIT — fastest safe-looking way to the cherry \(\d+ steps, worth 100 points\); /);
    expect(instructions).toMatch(/cherry worth 100 points \(as much as 10 pellets\).*One route is marked FRUIT/);
    expect(Object.values(criteria).join(' ')).not.toMatch(/cherry \(100 pts\)/);
  });

  it('says when the fruit cannot be reached in time and marks no route', () => {
    const s = createGame();
    s.fruit = { kind: 'cherry', points: 100, tile: { x: 13, y: 17 }, secondsLeft: 0.5 };
    const { instructions, criteria } = buildRequest(s, [pending(s, 'pacman')]).questions.pacman;
    expect(Object.values(criteria).some((v) => v.includes('FRUIT'))).toBe(false);
    expect(instructions).toMatch(/cherry worth 100 points.*cannot be reached safely in time/);
  });

  it('puts a reachable frightened ghost before the fruit while a power pellet is active', () => {
    const s = createGame();
    for (const id of ['pinky', 'inky', 'clyde'] as const) s.ghosts[id].releaseAt = Infinity;
    s.ghosts.blinky.state = 'frightened';
    s.frightLeft = 4;
    s.fruit = { kind: 'cherry', points: 100, tile: { x: 13, y: 17 }, secondsLeft: 9 };
    const { instructions } = buildRequest(s, [pending(s, 'pacman')]).questions.pacman;
    expect(instructions).toMatch(/Hunt a frightened ghost you can reach first; otherwise take the FRUIT route/);
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

describe('prompt styles', () => {
  const chased = () => {
    const s = createGame();
    s.mode = 'chase';
    // Pac-Man starts at (13,23) heading left; Blinky is 4 tiles behind him, closing in.
    Object.assign(s.ghosts.blinky, { state: 'normal', tile: { x: 17, y: 23 }, dir: 'left', progress: 0 });
    return s;
  };

  it('grid draws the whole maze; facts drops it; local draws the 11x11 window around Pac-Man', () => {
    const s = chased();
    const q = [pending(s, 'pacman')];
    expect(buildRequest(s, q, 'grid').state.maze).toHaveLength(31);
    expect(buildRequest(s, q, 'facts').state.maze).toBeUndefined();
    expect(buildRequest(s, q, 'rich').state.maze).toBeUndefined();
    const local = buildRequest(s, q, 'local').state.around_pacman as string[];
    expect(local).toHaveLength(11);
    expect(local.every((r) => r.length === 11)).toBe(true);
    expect(local[5][5]).toBe('P');
    expect(buildRequest(s, q, 'facts').questions.pacman).toEqual(buildRequest(s, q, 'grid').questions.pacman);
  });

  it('rich tells Pac-Man where each ghost is and puts safety first in every route', () => {
    const s = chased();
    const { instructions, criteria } = buildRequest(s, [pending(s, 'pacman')], 'rich').questions.pacman;
    expect(instructions).toMatch(/Blinky \d+ steps? away, behind you, closing in/);
    expect(instructions).toMatch(/Pinky, Inky and Clyde are still in the ghost house/);
    for (const text of Object.values(criteria)) {
      expect(text).toMatch(/^Go \w+: (DANGER|BLOCKED|you get to the junction|no dangerous ghost can)/);
      expect(text).toMatch(/pellets? in this corridor, \d+ within 15 steps/);
    }
    // Turning back right runs toward Blinky, who gets to the junction at (15,23) first.
    expect(criteria.right).toMatch(/^Go right: BLOCKED: Blinky gets to the junction at the end 2 steps before you; from there 0 of 2 ways on are clear/);
  });

  it('leaves the ghosts\' questions alone', () => {
    const s = chased();
    const q = [pending(s, 'blinky')];
    expect(buildRequest(s, q, 'rich').questions.blinky).toEqual(buildRequest(s, q, 'grid').questions.blinky);
  });
});
