import { Recorder, type Recording } from '../src/replay';
import { createGame, decisionPoints, step, type Controls } from '../src/sim';
import { scriptedControls } from '../scripts/game';

/**
 * A whole game recorded the way the bench records one, with the scripted rule playing Pac-Man too. Like the bench's
 * scheduler, Pac-Man only answers questions that were open before the step: one that comes up mid-step waits a frame.
 */
export function recordGame(cap = 300, dt = 1 / 60): Recording {
  const state = createGame();
  const recorder = new Recorder();
  const scripted = scriptedControls();
  let frame = 0;
  let open = new Set<string>();
  const ctl: Controls = {
    decide: (point, s) => (point.actor === 'pacman' && !open.has(point.key) ? null : scripted.decide(point, s)),
  };
  const recorded = recorder.wrap(ctl, () => frame);
  let survived = 0;
  while (state.status !== 'gameover' && survived < cap) {
    open = new Set(decisionPoints(state, 'pacman').map((p) => p.key));
    recorder.frames.push(dt);
    step(state, dt, recorded);
    if (state.status === 'playing') survived += dt;
    frame += 1;
  }
  return recorder.finish(state, 'scripted');
}
