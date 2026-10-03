import { DIRS, type Dir, type Tile } from './types';

export const DIR_VEC: Record<Dir, Tile> = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

export const REVERSE: Record<Dir, Dir> = { up: 'down', down: 'up', left: 'right', right: 'left' };

export class Maze {
  readonly width: number;
  readonly height: number;
  readonly pellets = new Set<number>();
  readonly powerPellets = new Set<number>();
  private readonly walls: boolean[] = [];
  private readonly distanceCache = new Map<number, Int16Array>();

  constructor(rows: readonly string[]) {
    this.height = rows.length;
    this.width = rows[0]?.length ?? 0;
    if (rows.some((row) => row.length !== this.width)) throw new Error('ragged layout');
    rows.forEach((row, y) =>
      [...row].forEach((c, x) => {
        this.walls.push(c === '#' || c === '-' || c === '_');
        if (c === '.') this.pellets.add(y * this.width + x);
        if (c === 'o') this.powerPellets.add(y * this.width + x);
      }),
    );
  }

  key(t: Tile): number {
    return t.y * this.width + t.x;
  }

  fromKey(k: number): Tile {
    return { x: k % this.width, y: Math.floor(k / this.width) };
  }

  isWalkable(t: Tile): boolean {
    if (t.y < 0 || t.y >= this.height) return false;
    const x = ((t.x % this.width) + this.width) % this.width;
    return !this.walls[t.y * this.width + x];
  }

  /** Adjacent tile in direction `d`, wrapping horizontally (the tunnel). */
  neighbor(t: Tile, d: Dir): Tile {
    const v = DIR_VEC[d];
    return { x: (t.x + v.x + this.width) % this.width, y: t.y + v.y };
  }

  openDirs(t: Tile): Dir[] {
    return DIRS.filter((d) => this.isWalkable(this.neighbor(t, d)));
  }

  /** BFS step counts from `from` to every tile (-1 = unreachable), never passing `blocked`. */
  distances(from: Tile, blocked?: Tile): Int16Array {
    const dist = new Int16Array(this.width * this.height).fill(-1);
    if (!this.isWalkable(from)) return dist;
    const blockedKey = blocked ? this.key(blocked) : -1;
    const queue = [this.key(from)];
    dist[queue[0]] = 0;
    for (let i = 0; i < queue.length; i++) {
      const tile = this.fromKey(queue[i]);
      for (const d of DIRS) {
        const n = this.neighbor(tile, d);
        if (!this.isWalkable(n)) continue;
        const k = this.key(n);
        if (k === blockedKey || dist[k] !== -1) continue;
        dist[k] = dist[queue[i]] + 1;
        queue.push(k);
      }
    }
    return dist;
  }

  /** Cached BFS distances to `to` (the maze is undirected, so from == to). */
  distanceMap(to: Tile): Int16Array {
    const k = this.key(to);
    let map = this.distanceCache.get(k);
    if (!map) {
      map = this.distances(to);
      this.distanceCache.set(k, map);
    }
    return map;
  }

  /** Closest walkable tile to `t` (clamped into the grid, then searched in growing diamonds). */
  nearestWalkable(t: Tile): Tile {
    const c = {
      x: Math.min(this.width - 1, Math.max(0, t.x)),
      y: Math.min(this.height - 1, Math.max(0, t.y)),
    };
    if (this.isWalkable(c)) return c;
    for (let r = 1; r < this.width + this.height; r++) {
      for (let dx = -r; dx <= r; dx++) {
        const dy = r - Math.abs(dx);
        for (const n of [{ x: c.x + dx, y: c.y + dy }, { x: c.x + dx, y: c.y - dy }]) {
          if (n.x >= 0 && n.x < this.width && this.isWalkable(n)) return n;
        }
      }
    }
    return c;
  }
}
