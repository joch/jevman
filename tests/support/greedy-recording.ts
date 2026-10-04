import { greedyChoice, optionFeatures } from '../../src/features';
import { Recorder, roundDt, type Recording } from '../../src/replay';
import { createGame, step } from '../../src/sim';

/** Plays a greedy game while recording, like `npm run bench -- --record`, but offline. */
export function recordGreedy(frames: number, dtFor = (frame: number) => 1 / 60 + (frame % 3) * 0.0011): Recording {
  const state = createGame();
  const rec = new Recorder();
  let frame = 0;
  const ctl = rec.wrap({ decide: (p) => greedyChoice(state, p, optionFeatures(state, p)) }, () => frame);
  for (; frame < frames && state.status !== 'gameover'; frame++) {
    const dt = roundDt(dtFor(frame));
    rec.frames.push(dt);
    step(state, dt, ctl);
  }
  return rec.finish(state, 'greedy');
}
