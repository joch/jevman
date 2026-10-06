import { describe, expect, it } from 'vitest';
import { Recorder, type Recording } from '../src/replay';
import { createGame, step } from '../src/sim';
import { scriptedControls } from '../scripts/game';
import { verifyGame } from '../scripts/verify';

/** A whole game with the scripted rule playing Pac-Man too, recorded the way the bench records one. */
function recordGame(): Recording {
  const state = createGame();
  const recorder = new Recorder();
  let frame = 0;
  const ctl = recorder.wrap(scriptedControls(), () => frame);
  let survived = 0;
  while (state.status !== 'gameover' && survived < 300) {
    recorder.frames.push(1 / 60);
    step(state, 1 / 60, ctl);
    if (state.status === 'playing') survived += 1 / 60;
    frame += 1;
  }
  return recorder.finish(state, 'scripted');
}

const honest = recordGame();
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

  it('refuses frames after game over and games cut short', () => {
    const longer = copy();
    longer.frames.push(1 / 60);
    longer.final.frames += 1;
    expect(verifyGame(longer)).toMatchObject({ ok: false, error: expect.stringMatching(/after game over/) });
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

  it('refuses negative costs and latencies', () => {
    const rec = copy();
    rec.events.push([0, { type: 'call', actors: ['pacman'], latencyMs: 10, costUsd: -10 } as never]);
    expect(verifyGame(rec)).toMatchObject({ ok: false, error: expect.stringMatching(/negative/) });
  });

  it('refuses files far bigger than a game, quickly', () => {
    const rec = copy();
    rec.decisions = Array.from({ length: 200_000 }, () => [0, 'pacman@1,1', 'left']);
    const t0 = performance.now();
    expect(verifyGame(rec)).toMatchObject({ ok: false, error: expect.stringMatching(/more decisions/) });
    expect(performance.now() - t0).toBeLessThan(100);
  });

  it('refuses malformed files instead of crashing', () => {
    expect(verifyGame({} as Recording).ok).toBe(false);
    expect(verifyGame({ ...copy(), decisions: [[0, 'pacman@1,1', 'sideways']] } as unknown as Recording).ok).toBe(false);
  });
});
