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
    expect(verifyGame(rec)).toMatchObject({ ok: false, error: expect.stringMatching(/at most 0.05 s/) });
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

  it('refuses malformed files instead of crashing', () => {
    expect(verifyGame({} as Recording).ok).toBe(false);
    expect(verifyGame({ ...copy(), decisions: [[0, 'pacman@1,1', 'sideways']] } as unknown as Recording).ok).toBe(false);
  });
});
