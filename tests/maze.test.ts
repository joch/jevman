import { describe, expect, it } from 'vitest';
import { CLASSIC_LAYOUT, GHOST_DOOR_EXIT, PACMAN_START } from '../src/layout';
import { Maze, REVERSE } from '../src/maze';

const maze = () => new Maze(CLASSIC_LAYOUT);

describe('Maze', () => {
  it('parses the classic 28x31 layout with 240 pellets and 4 power pellets', () => {
    const m = maze();
    expect(m.width).toBe(28);
    expect(m.height).toBe(31);
    expect(m.pellets.size).toBe(240);
    expect(m.powerPellets.size).toBe(4);
  });

  it('rejects ragged layouts', () => {
    expect(() => new Maze(['###', '##'])).toThrow(/ragged/);
  });

  it('treats walls, the ghost door and the house interior as not walkable', () => {
    const m = maze();
    expect(m.isWalkable({ x: 0, y: 0 })).toBe(false);
    expect(m.isWalkable({ x: 13, y: 12 })).toBe(false);
    expect(m.isWalkable({ x: 13, y: 14 })).toBe(false);
    expect(m.isWalkable({ x: 5, y: -1 })).toBe(false);
    expect(m.isWalkable(PACMAN_START)).toBe(true);
  });

  it('lists open directions', () => {
    expect(maze().openDirs({ x: 12, y: 23 }).sort()).toEqual(['left', 'right', 'up']);
  });

  it('wraps horizontally through the tunnel', () => {
    const m = maze();
    expect(m.neighbor({ x: 0, y: 14 }, 'left')).toEqual({ x: 27, y: 14 });
    expect(m.neighbor({ x: 27, y: 14 }, 'right')).toEqual({ x: 0, y: 14 });
    expect(m.openDirs({ x: 0, y: 14 }).sort()).toEqual(['left', 'right']);
  });

  it('computes BFS distances through the tunnel and marks unreachable tiles -1', () => {
    const m = maze();
    const d = m.distances({ x: 0, y: 14 });
    expect(d[m.key({ x: 27, y: 14 })]).toBe(1);
    expect(d[m.key({ x: 0, y: 0 })]).toBe(-1);
  });

  it('excludes a blocked tile from BFS', () => {
    const m = maze();
    const open = m.distances({ x: 11, y: 23 });
    const blocked = m.distances({ x: 11, y: 23 }, { x: 12, y: 23 });
    expect(open[m.key({ x: 13, y: 23 })]).toBe(2);
    expect(blocked[m.key({ x: 13, y: 23 })]).toBeGreaterThan(2);
  });

  it('finds the nearest walkable tile for off-grid or wall targets', () => {
    const m = maze();
    expect(m.nearestWalkable({ x: 1, y: 1 })).toEqual({ x: 1, y: 1 });
    expect(m.isWalkable(m.nearestWalkable({ x: -5, y: 40 }))).toBe(true);
    expect(m.isWalkable(m.nearestWalkable({ x: 13, y: 14 }))).toBe(true);
  });

  it('caches distance maps per target', () => {
    const m = maze();
    expect(m.distanceMap(GHOST_DOOR_EXIT)).toBe(m.distanceMap(GHOST_DOOR_EXIT));
  });

  it('reverses directions', () => {
    expect(REVERSE.up).toBe('down');
    expect(REVERSE.left).toBe('right');
  });
});
