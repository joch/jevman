import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { greedyChoice, optionFeatures } from '../src/features';
import { Recorder, Replay, roundDt, type Recording } from '../src/replay';
import { createGame, step } from '../src/sim';

/** Plays a greedy game while recording, like `npm run bench -- --record`, but offline. */
function recordGreedy(frames: number): Recording {
  const state = createGame();
  const rec = new Recorder();
  let frame = 0;
  const ctl = rec.wrap({ decide: (p) => greedyChoice(state, p, optionFeatures(state, p)) }, () => frame);
  for (; frame < frames && state.status !== 'gameover'; frame++) {
    const dt = roundDt(1 / 60 + (frame % 3) * 0.0011);
    rec.frames.push(dt);
    step(state, dt, ctl);
  }
  return rec.finish(state, 'greedy');
}

describe('Replay', () => {
  it('replays a recording to the same final state', () => {
    const rec = recordGreedy(1500);
    expect(rec.decisions.length).toBeGreaterThan(20);
    const replay = new Replay(rec);
    while (!replay.done) replay.stepFrame();
    expect({ score: replay.state.score, lives: replay.state.lives, level: replay.state.level, frames: replay.frame }).toEqual(rec.final);
  });

  it('hands out recorded events at their frame', () => {
    const rec: Recording = { ...recordGreedy(10), events: [[2, { type: 'error', message: 'x' }]] };
    const replay = new Replay(rec);
    expect(replay.stepFrame()).toEqual([]);
    expect(replay.stepFrame()).toEqual([]);
    expect(replay.stepFrame()).toEqual([{ type: 'error', message: 'x' }]);
  });

  it('stays put and hands out nothing once the recording is done', () => {
    const rec: Recording = { ...recordGreedy(3), events: [[2, { type: 'error', message: 'x' }]] };
    const replay = new Replay(rec);
    while (!replay.done) replay.stepFrame();
    const before = JSON.stringify(replay.state);
    expect(replay.stepFrame()).toEqual([]);
    expect(replay.frame).toBe(3);
    expect(JSON.stringify(replay.state)).toBe(before);
  });

  const DEMO = new URL('../public/demo/jev-demo.json', import.meta.url);
  it('replays the committed jev demo exactly (re-record if this fails after a sim change)', () => {
    expect(existsSync(DEMO), 'public/demo/jev-demo.json is missing').toBe(true);
    const rec = JSON.parse(readFileSync(DEMO, 'utf8')) as Recording;
    const replay = new Replay(rec);
    while (!replay.done) replay.stepFrame();
    expect({ score: replay.state.score, lives: replay.state.lives, level: replay.state.level, frames: replay.frame }).toEqual(rec.final);
  });
});
