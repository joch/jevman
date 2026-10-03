import { describe, expect, it } from 'vitest';
import { FRUIT_TILE, GHOST_DOOR_EXIT, PACMAN_START } from '../src/layout';
import {
  createGame,
  decisionKey,
  decisionPoints,
  escapePoint,
  DYING_SECONDS,
  fruitForLevel,
  LEVELCLEAR_SECONDS,
  modeAt,
  nextDecisionPoint,
  READY_SECONDS,
  step,
  type Controls,
  type GameState,
  type PacmanControl,
} from '../src/sim';
import { GHOST_IDS } from '../src/types';

const never: Controls = { decide: () => null };

function playing(pacmanControl: PacmanControl = 'jev'): GameState {
  const s = createGame({ pacmanControl });
  s.status = 'playing';
  s.statusTimer = 0;
  return s;
}

function parkGhosts(s: GameState): void {
  for (const id of GHOST_IDS) {
    s.ghosts[id].state = 'house';
    s.ghosts[id].releaseAt = Infinity;
  }
}

describe('game lifecycle', () => {
  it('starts ready with 3 lives and begins playing after READY_SECONDS', () => {
    const s = createGame();
    expect(s.status).toBe('ready');
    expect(s.lives).toBe(3);
    expect(s.pacmanControl).toBe('jev');
    step(s, READY_SECONDS + 0.01, never);
    expect(s.status).toBe('playing');
  });

  it('follows the classic scatter/chase schedule', () => {
    expect(modeAt(0)).toBe('scatter');
    expect(modeAt(6.9)).toBe('scatter');
    expect(modeAt(7.1)).toBe('chase');
    expect(modeAt(27.1)).toBe('scatter');
    expect(modeAt(1000)).toBe('chase');
  });

  it('releases ghosts from the house on their timers', () => {
    const s = playing();
    expect(s.ghosts.pinky.state).toBe('house');
    step(s, 1.05, never);
    expect(s.ghosts.pinky.state).toBe('normal');
    expect(s.ghosts.inky.state).toBe('house');
  });
});

describe('movement', () => {
  it('moves keyboard Pac-Man left from the start, eating pellets', () => {
    const s = playing('keyboard');
    parkGhosts(s);
    step(s, 0.5, never);
    expect(s.pacman.tile).toEqual({ x: 10, y: 23 });
    expect(s.score).toBe(30);
  });

  it('stops keyboard Pac-Man at a wall and turns when a key is pressed', () => {
    const s = playing('keyboard');
    parkGhosts(s);
    step(s, 2, never);
    expect(s.pacman.tile).toEqual({ x: 6, y: 23 });
    expect(s.pacman.waiting).toBe(true);
    s.keyDir = 'up';
    step(s, 0.2, never);
    expect(s.pacman.tile).toEqual({ x: 6, y: 22 });
    expect(s.pacman.dir).toBe('up');
  });

  it('reverses keyboard Pac-Man instantly mid-tile', () => {
    const s = playing('keyboard');
    parkGhosts(s);
    step(s, 0.1, never);
    s.keyDir = 'right';
    step(s, 1 / 60, never);
    expect(s.pacman.dir).toBe('right');
    expect(s.pacman.tile).toEqual({ x: 12, y: 23 });
  });

  it('wraps through the tunnel', () => {
    const s = playing('keyboard');
    parkGhosts(s);
    s.pacman.tile = { x: 1, y: 14 };
    s.pacman.dir = 'left';
    step(s, 0.3, never);
    expect(s.pacman.tile).toEqual({ x: 27, y: 14 });
  });

  it('makes jev Pac-Man wait at a junction until a decision arrives', () => {
    const s = playing('jev');
    parkGhosts(s);
    step(s, 0.5, never);
    expect(s.pacman.tile).toEqual({ x: 12, y: 23 });
    expect(s.pacman.waiting).toBe(true);
    expect(nextDecisionPoint(s, 'pacman')).toMatchObject({ tile: { x: 12, y: 23 }, distance: 0 });
    const upAt12: Controls = { decide: (p) => (p.tile.x === 12 && p.tile.y === 23 ? 'up' : null) };
    step(s, 0.1, upAt12);
    expect(s.pacman.waiting).toBe(false);
    expect(s.pacman.dir).toBe('up');
  });

  it('lets Pac-Man move on when toggled to keyboard while waiting for jev', () => {
    const s = playing('jev');
    parkGhosts(s);
    step(s, 0.5, never);
    expect(s.pacman.waiting).toBe(true);
    s.pacmanControl = 'keyboard';
    step(s, 0.1, never);
    expect(s.pacman.waiting).toBe(false);
    expect(s.pacman.dir).toBe('left');
  });
});

describe('decision points', () => {
  it('looks ahead to the upcoming junction', () => {
    const s = createGame();
    const pac = nextDecisionPoint(s, 'pacman')!;
    expect(pac.tile).toEqual({ x: 12, y: 23 });
    expect(pac.heading).toBe('left');
    expect(pac.distance).toBe(1);
    expect([...pac.options].sort()).toEqual(['left', 'right', 'up']);
    const blinky = nextDecisionPoint(s, 'blinky')!;
    expect(blinky.tile).toEqual({ x: 12, y: 11 });
    expect([...blinky.options].sort()).toEqual(['left', 'up']);
    expect(nextDecisionPoint(s, 'pinky')).toBeNull();
    expect(nextDecisionPoint(createGame({ pacmanControl: 'keyboard' }), 'pacman')).toBeNull();
  });

  it('changes the decision key when the situation changes', () => {
    const s = createGame();
    const tile = { x: 12, y: 11 };
    const k1 = decisionKey(s, 'blinky', tile, 'left');
    s.ghosts.blinky.state = 'frightened';
    const k2 = decisionKey(s, 'blinky', tile, 'left');
    s.mode = 'chase';
    const k3 = decisionKey(s, 'blinky', tile, 'left');
    s.ghosts.blinky.epoch += 1;
    const k4 = decisionKey(s, 'blinky', tile, 'left');
    expect(new Set([k1, k2, k3, k4]).size).toBe(4);
    const p1 = decisionKey(s, 'pacman', { x: 12, y: 23 }, 'left');
    s.frightLeft = 3;
    expect(decisionKey(s, 'pacman', { x: 12, y: 23 }, 'left')).not.toBe(p1);
  });

  it("keeps Pac-Man's decision key across a scatter/chase flip while a ghost's key changes", () => {
    const s = createGame();
    s.mode = 'scatter';
    const pTile = { x: 12, y: 23 };
    const gTile = { x: 12, y: 11 };
    const pKey = decisionKey(s, 'pacman', pTile, 'left');
    const gKey = decisionKey(s, 'blinky', gTile, 'left');
    s.mode = 'chase';
    expect(decisionKey(s, 'pacman', pTile, 'left')).toBe(pKey);
    expect(decisionKey(s, 'blinky', gTile, 'left')).not.toBe(gKey);
  });
});

describe('rules', () => {
  it('frightens ghosts on a power pellet and scores 200 then 400 for eating them', () => {
    const s = playing('keyboard');
    parkGhosts(s);
    Object.assign(s.ghosts.blinky, { state: 'normal', tile: { x: 26, y: 29 }, dir: 'left' });
    s.pacman.tile = { x: 3, y: 23 };
    s.pacman.dir = 'left';
    step(s, 0.27, never);
    expect(s.score).toBe(60);
    expect(s.frightLeft).toBeGreaterThan(5.9);
    expect(s.ghosts.blinky.state).toBe('frightened');
    for (const id of ['blinky', 'pinky'] as const) {
      Object.assign(s.ghosts[id], { state: 'frightened', tile: { x: 1, y: 23 }, dir: 'up', progress: 0, waiting: false });
    }
    step(s, 1 / 60, never);
    expect(s.ghosts.blinky.state).toBe('eaten');
    expect(s.ghosts.pinky.state).toBe('eaten');
    expect(s.score).toBe(660);
  });

  it('returns frightened ghosts to normal when the timer runs out', () => {
    const s = playing('keyboard');
    parkGhosts(s);
    Object.assign(s.ghosts.blinky, { state: 'frightened', tile: { x: 26, y: 29 }, dir: 'left' });
    s.frightLeft = 0.5;
    step(s, 0.6, never);
    expect(s.ghosts.blinky.state).toBe('normal');
  });

  it('sends eaten ghosts home to the door, where they revive', () => {
    const s = playing('keyboard');
    parkGhosts(s);
    Object.assign(s.ghosts.blinky, { state: 'eaten', tile: { x: 6, y: 5 }, dir: 'left', progress: 0 });
    step(s, 3, never);
    expect(s.ghosts.blinky.state).toBe('normal');
  });

  it('costs a life on touching a normal ghost and resets positions', () => {
    const s = playing('keyboard');
    parkGhosts(s);
    Object.assign(s.ghosts.blinky, { state: 'normal', tile: { ...PACMAN_START }, dir: 'left', progress: 0 });
    step(s, 1 / 60, never);
    expect(s.status).toBe('dying');
    const epoch = s.pacman.epoch;
    step(s, DYING_SECONDS, never);
    expect(s.lives).toBe(2);
    expect(s.status).toBe('ready');
    expect(s.pacman.tile).toEqual(PACMAN_START);
    expect(s.pacman.epoch).toBe(epoch + 1);
  });

  it('ends the game when the last life is lost', () => {
    const s = playing('keyboard');
    parkGhosts(s);
    s.lives = 1;
    Object.assign(s.ghosts.blinky, { state: 'normal', tile: { ...PACMAN_START }, dir: 'left', progress: 0 });
    step(s, 1 / 60, never);
    step(s, DYING_SECONDS, never);
    expect(s.status).toBe('gameover');
    step(s, 5, never);
    expect(s.status).toBe('gameover');
  });

  it('still catches Pac-Man with a ghost that is waiting for jev at a junction', () => {
    const s = playing('keyboard');
    parkGhosts(s);
    Object.assign(s.ghosts.blinky, { state: 'normal', tile: { x: 12, y: 23 }, dir: 'left', progress: 0, waiting: true });
    step(s, 0.2, never);
    expect(s.ghosts.blinky.waiting).toBe(true);
    expect(s.status).toBe('dying');
  });

  it('spawns fruit after 70 and 170 pellets and lets it expire after 9.5 s', () => {
    const s = playing('keyboard');
    parkGhosts(s);
    s.pelletsEaten = 69;
    step(s, 0.14, never);
    expect(s.fruit).toMatchObject({ kind: 'cherry', points: 100, tile: FRUIT_TILE });
    step(s, 9.6, never);
    expect(s.fruit).toBeNull();

    const t = playing('keyboard');
    parkGhosts(t);
    t.pelletsEaten = 169;
    t.fruitsSpawned = 1;
    step(t, 0.14, never);
    expect(t.fruit?.kind).toBe('cherry');
  });

  it('scores fruit when Pac-Man reaches it', () => {
    const s = playing('keyboard');
    parkGhosts(s);
    s.fruit = { kind: 'cherry', points: 100, tile: { x: 12, y: 23 }, secondsLeft: 5 };
    step(s, 0.14, never);
    expect(s.score).toBe(110);
    expect(s.fruit).toBeNull();
    expect(s.popups).toHaveLength(1);
  });

  it('picks fruit by level', () => {
    expect(fruitForLevel(1)).toEqual({ kind: 'cherry', points: 100 });
    expect(fruitForLevel(2)).toEqual({ kind: 'strawberry', points: 300 });
    expect(fruitForLevel(4)).toEqual({ kind: 'orange', points: 500 });
    expect(fruitForLevel(10)).toEqual({ kind: 'galaxian', points: 2000 });
    expect(fruitForLevel(20)).toEqual({ kind: 'key', points: 5000 });
  });

  it('clears the level on the last pellet and restores the maze', () => {
    const s = playing('keyboard');
    parkGhosts(s);
    s.maze.pellets.clear();
    s.maze.powerPellets.clear();
    s.maze.pellets.add(s.maze.key({ x: 12, y: 23 }));
    step(s, 0.14, never);
    expect(s.status).toBe('levelclear');
    step(s, LEVELCLEAR_SECONDS, never);
    expect(s.level).toBe(2);
    expect(s.maze.pellets.size).toBe(240);
    expect(s.status).toBe('ready');
    expect(s.ghosts.blinky.tile).toEqual(GHOST_DOOR_EXIT);
  });
});

describe('escape points', () => {
  function corridorWithGhostAhead(): GameState {
    const s = playing('jev');
    parkGhosts(s);
    Object.assign(s.pacman, { tile: { x: 10, y: 29 }, dir: 'left', progress: 0.5 });
    Object.assign(s.ghosts.blinky, { state: 'normal', tile: { x: 5, y: 29 }, dir: 'right', progress: 0 });
    return s;
  }

  it('offers keep-going or turn-back while a dangerous ghost is in the corridor ahead', () => {
    const s = corridorWithGhostAhead();
    const p = escapePoint(s)!;
    expect(p).toMatchObject({ actor: 'pacman', escape: true, heading: 'left', options: ['left', 'right'], distance: 0 });
    expect(decisionPoints(s, 'pacman').map((x) => !!x.escape)).toEqual([true, false]);
    s.ghosts.blinky.state = 'frightened';
    expect(escapePoint(s)).toBeNull();
    s.ghosts.blinky.state = 'normal';
    s.pacmanControl = 'keyboard';
    expect(escapePoint(s)).toBeNull();
  });

  it('asks early when a ghost can reach the junction ahead before Pac-Man', () => {
    const s = playing('jev');
    parkGhosts(s);
    Object.assign(s.pacman, { tile: { x: 7, y: 29 }, dir: 'right', progress: 0 });
    // Clyde is not in the corridor (8..12,29) but is 2 steps from its end junction (12,29); Pac-Man needs 5.
    Object.assign(s.ghosts.clyde, { state: 'normal', tile: { x: 12, y: 27 }, dir: 'down', progress: 0 });
    expect(escapePoint(s)).toMatchObject({ escape: true, threats: ['clyde'] });
    s.ghosts.clyde.tile = { x: 12, y: 20 };
    expect(escapePoint(s)).toBeNull();
  });

  it('keeps the escape question the same around a corner', () => {
    const s = playing('jev');
    parkGhosts(s);
    Object.assign(s.pacman, { tile: { x: 2, y: 29 }, dir: 'left', progress: 0 });
    Object.assign(s.ghosts.blinky, { state: 'normal', tile: { x: 1, y: 27 }, dir: 'down', progress: 0 });
    const before = escapePoint(s)!;
    Object.assign(s.pacman, { tile: { x: 1, y: 28 }, dir: 'up', progress: 0 });
    const after = escapePoint(s)!;
    expect(after.key).toBe(before.key);
    expect(after.options).toEqual(['up', 'down']);
  });

  it('never offers to turn back into a wall right after a corner', () => {
    const s = playing('jev');
    parkGhosts(s);
    // Just turned the corner at (1,29): moving up, and "down" from (1,29) is the outer wall.
    Object.assign(s.pacman, { tile: { x: 1, y: 29 }, dir: 'up', progress: 0 });
    Object.assign(s.ghosts.blinky, { state: 'normal', tile: { x: 1, y: 27 }, dir: 'down', progress: 0 });
    expect(escapePoint(s)).toBeNull();
    step(s, 0.5, { decide: (p) => (p.escape ? 'down' : null) });
    expect(s.maze.isWalkable(s.pacman.tile)).toBe(true);
  });

  it('ignores a dangerous ghost right behind Pac-Man', () => {
    const s = playing('jev');
    parkGhosts(s);
    Object.assign(s.pacman, { tile: { x: 9, y: 29 }, dir: 'left', progress: 0.6 });
    // Blinky follows on Pac-Man's own tile: it can only reach the junction ahead through him.
    Object.assign(s.ghosts.blinky, { state: 'normal', tile: { x: 10, y: 29 }, dir: 'left', progress: 0.6 });
    expect(escapePoint(s)).toBeNull();
    // One tile further behind.
    Object.assign(s.ghosts.blinky, { tile: { x: 10, y: 29 }, progress: 0 });
    expect(escapePoint(s)).toBeNull();
    // A ghost ahead still opens the question, and the one behind is not listed as a threat.
    Object.assign(s.ghosts.pinky, { state: 'normal', tile: { x: 5, y: 29 }, dir: 'right', progress: 0 });
    expect(escapePoint(s)).toMatchObject({ escape: true, threats: ['pinky'] });
  });

  it('only asks escape questions while playing', () => {
    const s = corridorWithGhostAhead();
    s.status = 'ready';
    expect(escapePoint(s)).toBeNull();
    s.status = 'dying';
    expect(escapePoint(s)).toBeNull();
  });

  it('turns Pac-Man back mid-tile when the answer is to turn back', () => {
    const s = corridorWithGhostAhead();
    step(s, 1 / 60, { decide: (p) => (p.escape ? 'right' : null) });
    expect(s.pacman.dir).toBe('right');
    expect(s.pacman.tile).toEqual({ x: 9, y: 29 });
    expect(s.pacman.waiting).toBe(false);
  });

  it('never makes Pac-Man wait for an escape answer', () => {
    const s = corridorWithGhostAhead();
    step(s, 0.2, never);
    expect(s.pacman.dir).toBe('left');
    expect(s.pacman.waiting).toBe(false);
    expect(s.pacman.tile.x).toBeLessThan(10);
  });
});
