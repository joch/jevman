import { Recorder, type Recording } from '../src/replay';
import { createGame, decisionPoints, step, type Controls } from '../src/sim';
import { scriptedControls } from '../scripts/game';

/**
 * A whole game recorded the way the bench records one, with the scripted rule playing Pac-Man too. Like the bench's
 * scheduler, Pac-Man only answers a question in a frame after the one it (last) opened in.
 */
export function recordGame(cap = 300, dt = 1 / 60): Recording {
  const state = createGame();
  const recorder = new Recorder();
  const scripted = scriptedControls();
  let frame = 0;
  const firstSeen = new Map<string, number>();
  const ctl: Controls = {
    decide: (point, s) => (point.actor === 'pacman' && !((firstSeen.get(point.key) ?? frame) < frame) ? null : scripted.decide(point, s)),
  };
  const recorded = recorder.wrap(ctl, () => frame);
  let survived = 0;
  while (state.status !== 'gameover' && survived < cap) {
    // Like the scheduler's update: a question that closed is forgotten, and asked again if it comes back.
    const open = new Set(decisionPoints(state, 'pacman').map((p) => p.key));
    for (const key of firstSeen.keys()) if (!open.has(key)) firstSeen.delete(key);
    for (const key of open) if (!firstSeen.has(key)) firstSeen.set(key, frame);
    recorder.frames.push(dt);
    step(state, dt, recorded);
    if (state.status === 'playing') survived += dt;
    frame += 1;
  }
  return recorder.finish(state, 'scripted');
}
