import { describe, expect, it } from 'vitest';
import { cuesBetween, snapshot } from '../src/sound';
import { createGame, step, type GameState } from '../src/sim';
import { GHOST_IDS } from '../src/types';

const never = { decide: () => null };
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
const run = (s: GameState, seconds: number) => {
  const cues: string[] = [];
  for (let t = 0; t < seconds; t += 1 / 60) {
    const before = snapshot(s);
    step(s, 1 / 60, never);
    cues.push(...cuesBetween(before, s));
  }
  return cues;
};

describe('sound cues', () => {
  it('wakas on pellets and sounds the power pellet', () => {
    const fresh = createGame({ pacmanControl: 'keyboard' });
    for (const id of GHOST_IDS) fresh.ghosts[id].releaseAt = Infinity;
    fresh.ghosts.blinky.state = 'house';
    const cues = run(fresh, 2);
    expect(cues).toContain('pellet');
    const s = playing();
    Object.assign(s.pacman, { tile: { x: 3, y: 23 }, dir: 'left', progress: 0 });
    expect(run(s, 0.3)).toContain('power');
  });

  it('cues fruit, ghosts and death', () => {
    const s = playing();
    s.fruit = { kind: 'cherry', points: 100, tile: { x: 12, y: 23 }, secondsLeft: 5 };
    expect(run(s, 0.14)).toContain('fruit');
    s.frightLeft = 3;
    Object.assign(s.ghosts.blinky, { state: 'frightened', tile: s.maze.neighbor(s.pacman.tile, s.pacman.dir), dir: 'right', progress: 0, waiting: false });
    expect(run(s, 0.2)).toContain('ghost');
    const d = playing();
    Object.assign(d.ghosts.blinky, { state: 'normal', tile: { x: 10, y: 23 }, dir: 'right', progress: 0 });
    expect(run(d, 0.4)).toContain('death');
  });
});
