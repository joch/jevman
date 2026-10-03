export type Dir = 'up' | 'down' | 'left' | 'right';
export const DIRS: readonly Dir[] = ['up', 'left', 'down', 'right'];

export type GhostId = 'blinky' | 'pinky' | 'inky' | 'clyde';
export const GHOST_IDS: readonly GhostId[] = ['blinky', 'pinky', 'inky', 'clyde'];

export type ActorId = 'pacman' | GhostId;
export const ACTOR_IDS: readonly ActorId[] = ['pacman', ...GHOST_IDS];

export interface Tile {
  x: number;
  y: number;
}

export const sameTile = (a: Tile, b: Tile): boolean => a.x === b.x && a.y === b.y;
