import { describe, expect, it } from 'vitest';
import { fruitRoute, goalFor, greedyChoice, isTrap, optionFeatures, saferChoice, type OptionFeatures } from '../src/features';
import { FRUIT_TILE, SCATTER_CORNERS } from '../src/layout';
import { createGame, escapePoint, nextDecisionPoint, type GameState } from '../src/sim';
import { GHOST_IDS, type Dir } from '../src/types';

function setup(): GameState {
  const s = createGame();
  s.status = 'playing';
  for (const id of GHOST_IDS) {
    s.ghosts[id].state = 'house';
    s.ghosts[id].releaseAt = Infinity;
  }
  return s;
}

const byDir = (feats: OptionFeatures[]) =>
  Object.fromEntries(feats.map((f) => [f.dir, f])) as Record<Dir, OptionFeatures>;

describe('optionFeatures for Pac-Man', () => {
  it('computes pellet distances and corridor pellets per option', () => {
    const s = setup();
    const point = nextDecisionPoint(s, 'pacman')!;
    const f = byDir(optionFeatures(s, point));
    expect(f.left.nearestPellet).toBe(1);
    expect(f.left.corridorPellets).toBe(3);
    expect(f.right.nearestPellet).toBe(3);
    expect(f.right.corridorPellets).toBe(1);
    expect(f.up.nearestPellet).toBe(1);
    expect(f.left.nearestDangerGhost).toBeNull();
    expect(f.left.fruitDistance).toBeNull();
    expect(f.left.pacmanDistance).toBeNull();
  });

  it('flags a dangerous ghost in the corridor and avoids it in the greedy fallback', () => {
    const s = setup();
    Object.assign(s.ghosts.blinky, { state: 'normal', tile: { x: 10, y: 23 }, dir: 'right', progress: 0 });
    const point = nextDecisionPoint(s, 'pacman')!;
    const feats = optionFeatures(s, point);
    const f = byDir(feats);
    expect(f.left.dangerInCorridor).toEqual(['blinky']);
    expect(f.left.nearestDangerGhost).toBe(2);
    expect(f.right.nearestDangerGhost).toBeGreaterThan(2);
    expect(greedyChoice(s, point, feats)).toBe('up');
  });

  it('reports fruit distance while fruit is on the board', () => {
    const s = setup();
    s.fruit = { kind: 'cherry', points: 100, tile: { ...FRUIT_TILE }, secondsLeft: 9 };
    const feats = optionFeatures(s, nextDecisionPoint(s, 'pacman')!);
    for (const f of feats) expect(f.fruitDistance).toBeGreaterThan(0);
  });

  it('hunts frightened ghosts in the greedy fallback while a power pellet is active', () => {
    const s = setup();
    s.frightLeft = 5;
    Object.assign(s.ghosts.inky, { state: 'frightened', tile: { x: 16, y: 23 }, dir: 'left', progress: 0 });
    const point = nextDecisionPoint(s, 'pacman')!;
    expect(greedyChoice(s, point, optionFeatures(s, point))).toBe('right');
  });
});

describe('ghost goals', () => {
  it('gives each ghost its personality in chase mode', () => {
    const s = setup();
    s.mode = 'chase';
    expect(goalFor(s, 'blinky')).toEqual({ kind: 'pacman', label: 'Pac-Man', target: { x: 13, y: 23 } });
    expect(goalFor(s, 'pinky')).toMatchObject({ kind: 'ambush', target: { x: 9, y: 23 } });
    const inky = goalFor(s, 'inky');
    expect(inky.kind).toBe('flank');
    expect(s.maze.isWalkable(inky.target!)).toBe(true);
    expect(goalFor(s, 'clyde').kind).toBe('pacman');
    Object.assign(s.ghosts.clyde, { state: 'normal', tile: { x: 9, y: 23 }, dir: 'left', progress: 0 });
    expect(goalFor(s, 'clyde')).toMatchObject({ kind: 'corner', target: SCATTER_CORNERS.clyde });
  });

  it('heads home in scatter mode and flees when frightened', () => {
    const s = setup();
    s.mode = 'scatter';
    expect(goalFor(s, 'blinky')).toMatchObject({ kind: 'corner', target: SCATTER_CORNERS.blinky });
    s.ghosts.blinky.state = 'frightened';
    expect(goalFor(s, 'blinky').kind).toBe('flee');
  });

  it('measures the chase goal as distance to Pac-Man and picks the closest option greedily', () => {
    const s = setup();
    s.mode = 'chase';
    s.ghosts.blinky.state = 'normal';
    const point = nextDecisionPoint(s, 'blinky')!;
    const feats = optionFeatures(s, point);
    for (const f of feats) expect(f.goalDistance).toBe(f.pacmanDistance);
    const best = [...feats].sort((a, b) => (a.goalDistance ?? 999) - (b.goalDistance ?? 999))[0];
    expect(greedyChoice(s, point, feats)).toBe(best.dir);
  });

  it('flees greedily by maximising distance to Pac-Man', () => {
    const s = setup();
    s.ghosts.blinky.state = 'frightened';
    s.frightLeft = 5;
    const point = nextDecisionPoint(s, 'blinky')!;
    const feats = optionFeatures(s, point);
    const best = [...feats].sort((a, b) => (b.pacmanDistance ?? 999) - (a.pacmanDistance ?? 999))[0];
    expect(greedyChoice(s, point, feats)).toBe(best.dir);
  });
});

describe('optionFeatures danger awareness', () => {
  it('reports the nearest power pellet via each option', () => {
    const s = setup();
    const f = byDir(optionFeatures(s, nextDecisionPoint(s, 'pacman')!));
    expect(f.left.nearestPowerPellet).toBe(17);
  });

  it('tells whether the nearest dangerous ghost is coming toward the route', () => {
    const s = setup();
    Object.assign(s.ghosts.blinky, { state: 'normal', tile: { x: 10, y: 23 }, dir: 'right', progress: 0 });
    expect(byDir(optionFeatures(s, nextDecisionPoint(s, 'pacman')!)).left.dangerApproaching).toBe(true);
    s.ghosts.blinky.dir = 'left';
    expect(byDir(optionFeatures(s, nextDecisionPoint(s, 'pacman')!)).left.dangerApproaching).toBe(false);
  });

  it('counts a ghost heading into the junction itself as coming toward the route', () => {
    const s = setup();
    // Pac-Man is about to reach junction (12,23); Blinky is just left of it, moving right into it.
    Object.assign(s.ghosts.blinky, { state: 'normal', tile: { x: 11, y: 23 }, dir: 'right', progress: 0 });
    const f = byDir(optionFeatures(s, nextDecisionPoint(s, 'pacman')!));
    expect(f.left.nearestDangerGhost).toBe(1);
    expect(f.left.dangerApproaching).toBe(true);
  });

  it('counts a ghost rounding a corner toward the route as coming toward it', () => {
    const s = setup();
    Object.assign(s.pacman, { tile: { x: 7, y: 29 }, dir: 'right', progress: 0 });
    // Clyde is coming down into the corner (1,29) and will turn right along row 29, toward junction (12,29).
    Object.assign(s.ghosts.clyde, { state: 'normal', tile: { x: 1, y: 28 }, dir: 'down', progress: 0.6 });
    const f = byDir(optionFeatures(s, nextDecisionPoint(s, 'pacman')!));
    expect(f.left.nearestDangerGhost).toBe(11);
    expect(f.left.dangerApproaching).toBe(true);
    Object.assign(s.ghosts.clyde, { tile: { x: 1, y: 29 }, dir: 'up', progress: 0.6 });
    expect(byDir(optionFeatures(s, nextDecisionPoint(s, 'pacman')!)).left.dangerApproaching).toBe(false);
  });

  it('counts dangerous ghosts nearby and detects a ghost winning the race to the next junction', () => {
    const s = setup();
    Object.assign(s.ghosts.blinky, { state: 'normal', tile: { x: 10, y: 23 }, dir: 'right', progress: 0 });
    Object.assign(s.ghosts.pinky, { state: 'normal', tile: { x: 9, y: 26 }, dir: 'up', progress: 0 });
    const point = nextDecisionPoint(s, 'pacman')!;
    const feats = optionFeatures(s, point);
    const f = byDir(feats);
    expect(f.left.dangerNearby).toBe(2);
    expect(f.left.junctionSteps).toBe(4); // 1 step to junction (12,23), then 3 along the corridor
    expect(f.left.junctionGhost).toEqual({ id: 'blinky', steps: 1 });
    expect(f.right.junctionGhost!.steps).toBeGreaterThan(f.right.junctionSteps);
    expect(greedyChoice(s, point, feats)).not.toBe('left');
  });

  it('counts the steps Pac-Man still needs to reach the junction in the race', () => {
    const s = setup();
    // Asked 7 tiles before junction (12,29); going right from there, the corridor to (15,29) is 3 more.
    Object.assign(s.pacman, { tile: { x: 5, y: 29 }, dir: 'right', progress: 0 });
    Object.assign(s.ghosts.pinky, { state: 'normal', tile: { x: 18, y: 26 }, dir: 'left', progress: 0 });
    const point = nextDecisionPoint(s, 'pacman')!;
    expect(point.tile).toEqual({ x: 12, y: 29 });
    expect(point.distance).toBe(7);
    const f = byDir(optionFeatures(s, point));
    expect(f.right.junctionGhost).toEqual({ id: 'pinky', steps: 6 });
    expect(f.right.junctionSteps).toBe(10);
    expect(isTrap(f.right)).toBe(true);
  });

  it('flags a trap even when no ghost is in the corridor itself', () => {
    const s = setup();
    Object.assign(s.ghosts.pinky, { state: 'normal', tile: { x: 9, y: 26 }, dir: 'up', progress: 0 });
    const point = nextDecisionPoint(s, 'pacman')!;
    const feats = optionFeatures(s, point);
    const f = byDir(feats);
    expect(f.left.dangerInCorridor).toEqual([]);
    expect(f.left.junctionGhost).toEqual({ id: 'pinky', steps: 3 });
    // Without the trap check, left (pellet 1 step away) would beat right (3 steps).
    expect(greedyChoice(s, point, feats.filter((x) => x.dir !== 'up'))).toBe('right');
  });
});

describe('optionFeatures for escape questions', () => {
  it('starts the turn-back route on the tile Pac-Man is leaving, not inside the wall behind it', () => {
    const s = setup();
    // Just rounded the corner at (1,29), 0.3 of the way up; (1,30) is the outer wall.
    Object.assign(s.pacman, { tile: { x: 1, y: 29 }, dir: 'up', progress: 0.3 });
    s.maze.pellets.delete(s.maze.key({ x: 1, y: 29 }));
    Object.assign(s.ghosts.blinky, { state: 'normal', tile: { x: 1, y: 27 }, dir: 'down', progress: 0 });
    const point = escapePoint(s)!;
    expect(point.options).toEqual(['up', 'down']);
    const f = byDir(optionFeatures(s, point));
    expect(f.down.nearestPellet).toBe(2);
    expect(f.down.corridorPellets).toBe(11);
    expect(f.down.junctionSteps).toBe(12);
    expect(f.down.dangerInCorridor).toEqual([]);
    expect(f.up.nearestDangerGhost).toBe(2);
    expect(f.up.dangerInCorridor).toEqual(['blinky']);
  });

  it('sees a ghost right behind Pac-Man on the turn-back route', () => {
    const s = setup();
    Object.assign(s.pacman, { tile: { x: 9, y: 29 }, dir: 'left', progress: 0.6 });
    Object.assign(s.ghosts.blinky, { state: 'normal', tile: { x: 5, y: 29 }, dir: 'right', progress: 0 });
    // Pinky follows on Pac-Man's own tile.
    Object.assign(s.ghosts.pinky, { state: 'normal', tile: { x: 10, y: 29 }, dir: 'left', progress: 0.6 });
    const point = escapePoint(s)!;
    expect(point.threats).toEqual(['blinky']);
    const f = byDir(optionFeatures(s, point));
    expect(f.right.nearestDangerGhost).toBe(1);
    expect(f.right.dangerInCorridor).toEqual(['pinky']);
    expect(f.right.dangerApproaching).toBe(true);
    expect(f.left.dangerInCorridor).toEqual(['blinky']);
  });
});

describe('fruitRoute', () => {
  const at = (distance: number) => ({ ...nextDecisionPoint(setup(), 'pacman')!, distance });
  const feat = (dir: Dir, over: Partial<OptionFeatures>): OptionFeatures => ({
    dir, goalDistance: null, pacmanDistance: null, nearestPellet: 5, corridorPellets: 0, nearestDangerGhost: null,
    dangerInCorridor: [], nearestFrightenedGhost: null, frightenedGhostSteps: [], fruitDistance: null, nearestPowerPellet: null,
    dangerApproaching: false, dangerNearby: 0, junctionSteps: 3, junctionGhost: null, ...over,
  });

  it('saferChoice swaps an unsafe pick for the safe route jev rated highest, and only then', () => {
    const feats = [
      feat('up', { dangerInCorridor: ['blinky'] }),
      feat('left', {}),
      feat('down', { nearestDangerGhost: 2 }),
      feat('right', {}),
    ];
    const p = { up: 0.6, left: 0.1, down: 0.05, right: 0.25 };
    expect(saferChoice('up', p, feats)).toBe('right');
    expect(saferChoice('down', p, feats)).toBe('right');
    expect(saferChoice('left', p, feats)).toBeNull();
    const cornered = [feat('up', { dangerInCorridor: ['blinky'] }), feat('down', { junctionGhost: { id: 'inky', steps: 1 } })];
    expect(saferChoice('up', { up: 0.9, down: 0.1 }, cornered)).toBeNull();
  });

  it('picks the fastest route that reaches the fruit in time and is not dangerous', () => {
    const s = setup();
    s.fruit = { kind: 'cherry', points: 100, tile: { ...FRUIT_TILE }, secondsLeft: 4 }; // reach: 28 steps
    const feats = [
      feat('up', { nearestPellet: 1, fruitDistance: 30 }),
      feat('left', { fruitDistance: 12, dangerInCorridor: ['blinky'] }),
      feat('down', { fruitDistance: 14 }),
      feat('right', { fruitDistance: 9, junctionGhost: { id: 'pinky', steps: 2 } }), // trap
    ];
    expect(fruitRoute(s, at(0), feats)).toBe('down');
    // The walk to the junction counts: 15 more steps put the down route (14) out of reach too.
    expect(fruitRoute(s, at(15), feats)).toBeNull();
    expect(fruitRoute(s, at(14), feats)).toBe('down');
  });

  it('avoids a fruit route through a frightened ghost that turns dangerous before Pac-Man gets there', () => {
    const s = setup();
    s.fruit = { kind: 'cherry', points: 100, tile: { ...FRUIT_TILE }, secondsLeft: 5 };
    const feats = [feat('up', { fruitDistance: 10, nearestFrightenedGhost: 6, frightenedGhostSteps: [6] }), feat('down', { fruitDistance: 14 })];
    s.frightLeft = 0.5; // 3 steps: the ghost 6 steps up is normal again by then
    expect(fruitRoute(s, at(0), feats)).toBe('down');
    s.frightLeft = 2; // 14 steps: still edible when Pac-Man reaches it
    expect(fruitRoute(s, at(0), feats)).toBe('up');
    // Two ghosts on the way: the near one is still edible, the far one is not.
    feats[0] = feat('up', { fruitDistance: 20, nearestFrightenedGhost: 6, frightenedGhostSteps: [6, 18] });
    feats[1] = feat('down', { fruitDistance: 24 });
    expect(fruitRoute(s, at(0), feats)).toBe('down');
  });

  it('gives no route when the fruit cannot be reached in time or is absent', () => {
    const s = setup();
    s.fruit = { kind: 'cherry', points: 100, tile: { ...FRUIT_TILE }, secondsLeft: 1 }; // reach: 7 steps
    expect(fruitRoute(s, at(0), [feat('up', { fruitDistance: 12 })])).toBeNull();
    s.fruit = null;
    expect(fruitRoute(s, at(0), [feat('up', { fruitDistance: 2 })])).toBeNull();
  });

  it('makes the greedy fallback hunt only frightened ghosts it can reach before the fright ends', () => {
    const s = setup();
    s.fruit = { kind: 'cherry', points: 100, tile: { ...FRUIT_TILE }, secondsLeft: 5 };
    const point = nextDecisionPoint(s, 'pacman')!;
    const feats = [feat('up', { nearestFrightenedGhost: 10, frightenedGhostSteps: [10] }), feat('left', { fruitDistance: 8 }), feat('right', { nearestPellet: 1 })];
    s.frightLeft = 0.5; // 3 steps of fright left: the ghost will be dangerous again by then
    expect(greedyChoice(s, { ...point, distance: 0 }, feats)).toBe('left');
    s.frightLeft = 4;
    expect(greedyChoice(s, { ...point, distance: 0 }, feats)).toBe('up');
  });

  it('makes the greedy fallback go for the fruit instead of the nearest pellet', () => {
    const s = setup();
    s.fruit = { kind: 'cherry', points: 100, tile: { ...FRUIT_TILE }, secondsLeft: 5 };
    const point = nextDecisionPoint(s, 'pacman')!;
    const feats = [feat('up', { nearestPellet: 1, fruitDistance: 30 }), feat('left', { nearestPellet: 6, fruitDistance: 8 }), feat('right', { nearestPellet: 3 })];
    expect(greedyChoice(s, point, feats)).toBe('left');
  });
});
