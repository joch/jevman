import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Recording } from '../src/replay';
import { recordGame } from './record-game';
import { createGame, decisionPoints, step, type DecisionPoint } from '../src/sim';
import type { Dir } from '../src/types';
import { scriptedControls } from '../scripts/game';
import { verifyGame as verifyWith } from '../scripts/verify';
import type { SubmissionRules } from '../shared/leaderboard';

// Short games keep the replays quick (CI runners are slow); the rules are the bench's apart from the cap.
const RULES: SubmissionRules = { minGames: 1, maxSeconds: 30, maxStep: 0.05 };
const verifyGame = (rec: Recording, rules = RULES) => verifyWith(rec, rules);


const honest = recordGame(RULES.maxSeconds);

/** Replays a recording as verifyGame does, reporting each of Pac-Man's questions with the ones open before that step. */
function replay(rec: Recording, onQuestion: (frame: number, point: DecisionPoint, open: Set<string>) => void, onFrame?: (frame: number, open: Set<string>) => void): void {
  const moves = new Map<string, Dir[]>();
  for (const [f, key, dir] of rec.decisions) if (/^pacman[@~]/.test(key)) moves.set(`${f}|${key}`, [...(moves.get(`${f}|${key}`) ?? []), dir]);
  const s = createGame();
  const ghosts = scriptedControls();
  for (let f = 0; f < rec.frames.length; f++) {
    const open = new Set(decisionPoints(s, 'pacman').map((p) => p.key));
    onFrame?.(f, open);
    step(s, rec.frames[f], {
      decide: (point, st) => {
        if (point.actor !== 'pacman') return ghosts.decide(point, st);
        onQuestion(f, point, open);
        return moves.get(`${f}|${point.key}`)?.shift() ?? null;
      },
    });
  }
}
const copy = (): Recording => structuredClone(honest);

describe('verifyGame', () => {
  it('accepts an honest recording and recomputes its result', () => {
    const v = verifyGame(copy());
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.result.score).toBe(honest.final.score);
  });

  it('refuses a recording that claims a better score than its moves earn', () => {
    const rec = copy();
    rec.final.score += 1000;
    expect(verifyGame(rec)).toMatchObject({ ok: false, error: expect.stringMatching(/claims score/) });
  });

  it("refuses a recording whose Pac-Man moves don't give the recorded game", () => {
    const rec = copy();
    const i = rec.decisions.findIndex(([, key]) => key.startsWith('pacman@'));
    const [, , dir] = rec.decisions[i];
    rec.decisions[i][2] = dir === 'left' ? 'right' : 'left';
    expect(verifyGame(rec).ok).toBe(false);
  });

  it('plays the ghosts by the scripted rule, whatever the recording says they did', () => {
    const rec = copy();
    for (const d of rec.decisions) if (d[1].startsWith('blinky')) d[2] = 'up';
    expect(verifyGame(rec).ok).toBe(true);
  });

  it('refuses steps longer than the bench ever takes', () => {
    const rec = copy();
    rec.frames[100] = 0.2;
    expect(verifyGame(rec)).toMatchObject({ ok: false, error: expect.stringMatching(/a step must be 0.001 to 0.05 s/) });
  });

  it('refuses frames after the game ended and games cut short', () => {
    // The short test game ends at the time cap; the committed demo, a real jev game, ends at game over.
    const longer = copy();
    longer.frames.push(1 / 60);
    longer.final.frames += 1;
    expect(verifyGame(longer)).toMatchObject({ ok: false, error: expect.stringMatching(/past the 30 s cap/) });
    const demo = JSON.parse(readFileSync('public/demo/jev-demo.json', 'utf8')) as Recording;
    expect(verifyWith(demo).ok).toBe(true);
    demo.frames.push(1 / 60);
    demo.final.frames += 1;
    expect(verifyWith(demo)).toMatchObject({ ok: false, error: expect.stringMatching(/after game over/) });
    const shorter = copy();
    shorter.frames.splice(-200);
    shorter.final.frames -= 200;
    expect(verifyGame(shorter).ok).toBe(false);
  });

  it('refuses moves the bench scheduler could never have made', () => {
    // An escape question answered a second time while it is still open.
    const twice = copy();
    const escape = twice.decisions.find(([, key]) => key.startsWith('pacman~'));
    if (escape) {
      twice.decisions.push([escape[0] + 1, escape[1], escape[2]]);
      twice.decisions.sort((a, b) => a[0] - b[0]);
      expect(verifyGame(twice).ok).toBe(false);
    }
    // A model that took 5 s while the game waited: the bench would have fallen back by then.
    const late = copy();
    const i = late.decisions.findIndex(([, key]) => key.startsWith('pacman@'));
    late.frames.splice(late.decisions[i][0], 0, ...Array(100).fill(0.05));
    for (const d of late.decisions) if (d[0] >= late.decisions[i][0]) d[0] += 100;
    late.final.frames = late.frames.length;
    expect(verifyGame(late)).toMatchObject({ ok: false, error: expect.stringMatching(/an answer after more than 4.5 s/) });
  });

  it('refuses an answer to a question that only came up during the step', () => {
    // A question the game asks in the middle of a step, before any scheduler update could have seen it.
    const rec = copy();
    let found: [number, string, Dir] | null = null;
    replay(rec, (f, point, open) => {
      if (!found && !open.has(point.key)) found = [f, point.key, point.options[0]];
    });
    expect(found).not.toBeNull();
    rec.decisions.push(found!);
    rec.decisions.sort((a, b) => a[0] - b[0]);
    expect(verifyGame(rec)).toMatchObject({ ok: false, error: expect.stringMatching(/not asked yet/) });
  });

  it('refuses an answer in the very frame its question was first asked', () => {
    // A question the game asked in the same frame it opened (Pac-Man got there and had to wait): the bench's answer
    // arrives a frame later at the soonest. Moving the recorded answer into that frame must be refused.
    const rec = copy();
    const openedAt = new Map<string, number>();
    let target: { key: string; frame: number } | null = null;
    replay(
      rec,
      (f, point) => {
        if (!target && openedAt.get(point.key) === f && rec.decisions.some(([df, key]) => key === point.key && df > f)) target = { key: point.key, frame: f };
      },
      (f, open) => {
        for (const key of [...openedAt.keys()]) if (!open.has(key)) openedAt.delete(key);
        for (const key of open) if (!openedAt.has(key)) openedAt.set(key, f);
      },
    );
    expect(target).not.toBeNull();
    const d = rec.decisions.find(([df, key]) => key === target!.key && df > target!.frame)!;
    d[0] = target!.frame;
    rec.decisions.sort((a, b) => a[0] - b[0]);
    expect(verifyGame(rec)).toMatchObject({ ok: false, error: expect.stringMatching(/not asked yet/) });
  });

  it('refuses negative or infinite costs and latencies', () => {
    for (const call of [{ latencyMs: 10, costUsd: -10 }, { latencyMs: 10, costUsd: JSON.parse('1e400') }, { latencyMs: Infinity, costUsd: null }, { latencyMs: '10', costUsd: null }, { latencyMs: 10, costUsd: 1e308 }]) {
      const rec = copy();
      rec.events.push([0, { type: 'call', actors: ['pacman'], ...call } as never]);
      expect(verifyGame(rec)).toMatchObject({ ok: false, error: expect.stringMatching(/negative or impossible/) });
    }
  });

  it('refuses files far bigger than a game, quickly', () => {
    const rec = copy();
    rec.decisions = Array.from({ length: 200_000 }, () => [0, 'pacman@1,1', 'left']);
    const t0 = performance.now();
    expect(verifyGame(rec)).toMatchObject({ ok: false, error: expect.stringMatching(/more decisions/) });
    expect(performance.now() - t0).toBeLessThan(100);
  });

  it('accepts a game that reaches the time cap, but not one stopped a step short', () => {
    const rules = { minGames: 1, maxSeconds: 20, maxStep: 0.05 };
    const capped = recordGame(rules.maxSeconds);
    expect(verifyGame(capped, rules).ok).toBe(true);
    const short = structuredClone(capped);
    short.frames.pop();
    short.final.frames -= 1;
    expect(verifyGame(short, rules)).toMatchObject({ ok: false, error: expect.stringMatching(/stops before game over or the time cap/) });
  });

  it('refuses malformed files instead of crashing', () => {
    expect(verifyGame({} as Recording).ok).toBe(false);
    expect(verifyGame({ ...copy(), decisions: [[0, 'pacman@1,1', 'sideways']] } as unknown as Recording).ok).toBe(false);
  });
});
