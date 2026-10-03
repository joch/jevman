import { CLASSIC_LAYOUT, FRUIT_TILE, GHOST_DOOR_EXIT, HOUSE_TILES, PACMAN_START } from './layout';
import { DIR_VEC, Maze, REVERSE } from './maze';
import { GHOST_IDS, sameTile, type ActorId, type Dir, type GhostId, type Tile } from './types';

export type GhostState = 'house' | 'normal' | 'frightened' | 'eaten';
export type Mode = 'scatter' | 'chase';
export type Status = 'ready' | 'playing' | 'dying' | 'levelclear' | 'gameover';
export type PacmanControl = 'keyboard' | 'jev';

export interface Actor {
  id: ActorId;
  tile: Tile;
  dir: Dir;
  progress: number;
  waiting: boolean;
  /** Bumped whenever the actor is repositioned, so stale decisions can be recognised. */
  epoch: number;
}

export interface Ghost extends Actor {
  id: GhostId;
  state: GhostState;
  releaseAt: number;
}

export interface Fruit {
  kind: string;
  points: number;
  tile: Tile;
  secondsLeft: number;
}

export interface Popup {
  tile: Tile;
  text: string;
  ttl: number;
}

export interface GameState {
  layout: readonly string[];
  maze: Maze;
  pacman: Actor;
  ghosts: Record<GhostId, Ghost>;
  pacmanControl: PacmanControl;
  keyDir: Dir | null;
  status: Status;
  statusTimer: number;
  mode: Mode;
  modeTime: number;
  frightLeft: number;
  frightChain: number;
  score: number;
  lives: number;
  level: number;
  pelletsEaten: number;
  fruit: Fruit | null;
  fruitsSpawned: number;
  lifeTime: number;
  popups: Popup[];
}

export interface DecisionPoint {
  actor: ActorId;
  tile: Tile;
  heading: Dir;
  options: Dir[];
  key: string;
}

export interface Controls {
  decide(point: DecisionPoint): Dir | null;
}

export const SPEED = { pacman: 7.5, ghost: 7, frightened: 4.5, eaten: 14 } as const; // tiles per second
export const READY_SECONDS = 1.5;
export const DYING_SECONDS = 1.5;
export const LEVELCLEAR_SECONDS = 2;
export const FRUIT_SECONDS = 9.5;
export const FRUIT_THRESHOLDS: readonly number[] = [70, 170];

const RELEASE_AT: Record<GhostId, number> = { blinky: 0, pinky: 1, inky: 4, clyde: 7 };
const MODE_SCHEDULE: readonly [Mode, number][] = [
  ['scatter', 7], ['chase', 20], ['scatter', 7], ['chase', 20],
  ['scatter', 5], ['chase', 20], ['scatter', 5], ['chase', Infinity],
];
const FRUITS: readonly [maxLevel: number, kind: string, points: number][] = [
  [1, 'cherry', 100], [2, 'strawberry', 300], [4, 'orange', 500], [6, 'apple', 700],
  [8, 'melon', 1000], [10, 'galaxian', 2000], [12, 'bell', 3000], [Infinity, 'key', 5000],
];
const SUBSTEP = 1 / 60;
const COLLISION_DISTANCE = 0.6;
const EPSILON = 1e-9;

export function modeAt(seconds: number): Mode {
  let t = seconds;
  for (const [mode, length] of MODE_SCHEDULE) {
    if (t < length) return mode;
    t -= length;
  }
  return 'chase';
}

export const frightSeconds = (level: number): number => Math.max(2, 7 - level);

export function fruitForLevel(level: number): { kind: string; points: number } {
  const [, kind, points] = FRUITS.find(([maxLevel]) => level <= maxLevel)!;
  return { kind, points };
}

export function createGame(opts: { pacmanControl?: PacmanControl } = {}): GameState {
  const base = { tile: { x: 0, y: 0 }, dir: 'left' as Dir, progress: 0, waiting: false, epoch: 0 };
  const ghosts = Object.fromEntries(
    GHOST_IDS.map((id) => [id, { ...base, id, state: 'house' as GhostState, releaseAt: 0 }]),
  ) as Record<GhostId, Ghost>;
  const state: GameState = {
    layout: CLASSIC_LAYOUT,
    maze: new Maze(CLASSIC_LAYOUT),
    pacman: { ...base, id: 'pacman' },
    ghosts,
    pacmanControl: opts.pacmanControl ?? 'jev',
    keyDir: null,
    status: 'ready',
    statusTimer: READY_SECONDS,
    mode: 'scatter',
    modeTime: 0,
    frightLeft: 0,
    frightChain: 0,
    score: 0,
    lives: 3,
    level: 1,
    pelletsEaten: 0,
    fruit: null,
    fruitsSpawned: 0,
    lifeTime: 0,
    popups: [],
  };
  resetPositions(state);
  return state;
}

/** Start of a life: everyone back to their start tile, ghosts back in the house, timers reset. */
export function resetPositions(state: GameState): void {
  const p = state.pacman;
  p.tile = { ...PACMAN_START };
  p.dir = 'left';
  p.progress = 0;
  p.waiting = false;
  p.epoch += 1;
  for (const id of GHOST_IDS) {
    const g = state.ghosts[id];
    g.tile = { ...HOUSE_TILES[id] };
    g.dir = id === 'blinky' ? 'left' : 'up';
    g.progress = 0;
    g.waiting = false;
    g.epoch += 1;
    g.state = id === 'blinky' ? 'normal' : 'house';
    g.releaseAt = RELEASE_AT[id];
  }
  state.status = 'ready';
  state.statusTimer = READY_SECONDS;
  state.mode = 'scatter';
  state.modeTime = 0;
  state.frightLeft = 0;
  state.frightChain = 0;
  state.lifeTime = 0;
  state.keyDir = null;
}

export const actorOf = (state: GameState, id: ActorId): Actor =>
  id === 'pacman' ? state.pacman : state.ghosts[id];

const ghostList = (state: GameState): Ghost[] => GHOST_IDS.map((id) => state.ghosts[id]);

export function isJevDriven(state: GameState, id: ActorId): boolean {
  if (id === 'pacman') return state.pacmanControl === 'jev';
  const s = state.ghosts[id].state;
  return s === 'normal' || s === 'frightened';
}

/** Continuous position in tile units (may be slightly outside the grid inside the tunnel). */
export function actorPosition(a: Actor): { x: number; y: number } {
  const v = DIR_VEC[a.dir];
  return { x: a.tile.x + v.x * a.progress, y: a.tile.y + v.y * a.progress };
}

/** The tile an actor is mostly on. */
export function occupiedTile(state: GameState, a: Actor): Tile {
  return a.progress >= 0.5 ? state.maze.neighbor(a.tile, a.dir) : a.tile;
}

/** The only sensible way on from `tile` when arriving with `heading`, or null at a real junction. */
function forcedDir(state: GameState, tile: Tile, heading: Dir): Dir | null {
  const open = state.maze.openDirs(tile);
  const ahead = open.filter((d) => d !== REVERSE[heading]);
  if (ahead.length === 1) return ahead[0];
  if (ahead.length === 0) return open[0] ?? null;
  return null;
}

/** Directions offered at a junction: ghosts may not reverse, Pac-Man may. */
export function optionsAt(state: GameState, id: ActorId, tile: Tile, heading: Dir): Dir[] {
  const open = state.maze.openDirs(tile);
  return id === 'pacman' ? open : open.filter((d) => d !== REVERSE[heading]);
}

/** Identifies one decision in one situation. Any change of epoch, mood or mode makes old answers stale. */
export function decisionKey(state: GameState, id: ActorId, tile: Tile, heading: Dir): string {
  const mood = id === 'pacman' ? (state.frightLeft > 0 ? 'hunt' : 'eat') : state.ghosts[id].state;
  return `${id}@${tile.x},${tile.y}>${heading}#${actorOf(state, id).epoch}:${mood}:${state.mode}`;
}

export function decisionPointAt(state: GameState, id: ActorId, tile: Tile, heading: Dir): DecisionPoint | null {
  if (forcedDir(state, tile, heading) !== null) return null;
  return {
    actor: id,
    tile: { ...tile },
    heading,
    options: optionsAt(state, id, tile, heading),
    key: decisionKey(state, id, tile, heading),
  };
}

/** The next junction where a jev-driven actor needs a decision, walking forward from where it is. */
export function nextDecisionPoint(state: GameState, id: ActorId): DecisionPoint | null {
  if (!isJevDriven(state, id)) return null;
  const a = actorOf(state, id);
  if (a.waiting) return decisionPointAt(state, id, a.tile, a.dir);
  let tile = state.maze.neighbor(a.tile, a.dir);
  let heading = a.dir;
  for (let i = 0; i < state.maze.width * state.maze.height; i++) {
    const point = decisionPointAt(state, id, tile, heading);
    if (point) return point;
    heading = forcedDir(state, tile, heading)!;
    tile = state.maze.neighbor(tile, heading);
  }
  return null;
}

export function step(state: GameState, dt: number, ctl: Controls): void {
  state.popups = state.popups.filter((p) => (p.ttl -= dt) > 0);
  if (state.status === 'gameover') return;
  if (state.status !== 'playing') {
    state.statusTimer -= dt;
    if (state.statusTimer > EPSILON) return;
    if (state.status === 'ready') {
      state.status = 'playing';
    } else if (state.status === 'dying') {
      state.lives -= 1;
      if (state.lives <= 0) state.status = 'gameover';
      else resetPositions(state);
    } else if (state.status === 'levelclear') {
      state.level += 1;
      state.maze = new Maze(state.layout);
      state.pelletsEaten = 0;
      state.fruit = null;
      state.fruitsSpawned = 0;
      resetPositions(state);
    }
    return;
  }
  for (let left = dt; left > EPSILON && state.status === 'playing'; left -= SUBSTEP) {
    tick(state, Math.min(left, SUBSTEP), ctl);
  }
}

function tick(state: GameState, h: number, ctl: Controls): void {
  state.lifeTime += h;
  if (state.frightLeft > 0) {
    state.frightLeft = Math.max(0, state.frightLeft - h);
    if (state.frightLeft === 0) for (const g of ghostList(state)) if (g.state === 'frightened') g.state = 'normal';
  } else {
    state.modeTime += h;
    state.mode = modeAt(state.modeTime);
  }
  if (state.fruit) {
    state.fruit.secondsLeft -= h;
    if (state.fruit.secondsLeft <= 0) state.fruit = null;
  }
  for (const g of ghostList(state)) if (g.state === 'house' && state.lifeTime >= g.releaseAt) release(g);

  moveActor(state, state.pacman, h, ctl);
  if (state.status !== 'playing') return; // the last pellet was just eaten
  for (const g of ghostList(state)) if (g.state !== 'house') moveActor(state, g, h, ctl);
  checkCollisions(state);
}

function release(g: Ghost): void {
  g.state = 'normal';
  g.tile = { ...GHOST_DOOR_EXIT };
  g.dir = 'left';
  g.progress = 0;
  g.waiting = false;
  g.epoch += 1;
}

function speedOf(a: Actor): number {
  if (a.id === 'pacman') return SPEED.pacman;
  const s = (a as Ghost).state;
  return s === 'eaten' ? SPEED.eaten : s === 'frightened' ? SPEED.frightened : SPEED.ghost;
}

function moveActor(state: GameState, a: Actor, h: number, ctl: Controls): void {
  if (a.waiting && !chooseAt(state, a, ctl)) return;
  if (a.id === 'pacman' && state.pacmanControl === 'keyboard' && state.keyDir === REVERSE[a.dir] && a.progress > 0) {
    a.tile = state.maze.neighbor(a.tile, a.dir);
    a.dir = state.keyDir;
    a.progress = 1 - a.progress;
  }
  a.progress += speedOf(a) * h;
  while (a.progress >= 1) {
    a.tile = state.maze.neighbor(a.tile, a.dir);
    a.progress -= 1;
    onArrive(state, a);
    if (!chooseAt(state, a, ctl)) {
      a.progress = 0;
      return;
    }
  }
}

/** Picks the direction to leave `a.tile`; marks the actor waiting when none is available yet. */
function chooseAt(state: GameState, a: Actor, ctl: Controls): boolean {
  const dir = nextDir(state, a, ctl);
  if (dir === null) {
    a.waiting = true;
    return false;
  }
  a.dir = dir;
  a.waiting = false;
  return true;
}

function nextDir(state: GameState, a: Actor, ctl: Controls): Dir | null {
  const { maze } = state;
  if (a.id === 'pacman' && state.pacmanControl === 'keyboard') {
    const open = maze.openDirs(a.tile);
    if (state.keyDir && open.includes(state.keyDir)) return state.keyDir;
    return open.includes(a.dir) ? a.dir : null;
  }
  if (a.id !== 'pacman' && (a as Ghost).state === 'eaten') {
    const home = maze.distanceMap(GHOST_DOOR_EXIT);
    const dist = (d: Dir) => home[maze.key(maze.neighbor(a.tile, d))];
    return maze.openDirs(a.tile).reduce((best, d) => (dist(d) < dist(best) ? d : best));
  }
  const forced = forcedDir(state, a.tile, a.dir);
  if (forced) return forced;
  const point = decisionPointAt(state, a.id, a.tile, a.dir)!;
  const choice = ctl.decide(point);
  return choice && point.options.includes(choice) ? choice : null;
}

function onArrive(state: GameState, a: Actor): void {
  if (a.id === 'pacman') {
    eatAt(state, a.tile);
    return;
  }
  const g = a as Ghost;
  if (g.state === 'eaten' && sameTile(g.tile, GHOST_DOOR_EXIT)) {
    g.state = 'normal';
    g.epoch += 1;
  }
}

function eatAt(state: GameState, tile: Tile): void {
  const { maze } = state;
  const k = maze.key(tile);
  if (maze.pellets.delete(k)) {
    state.score += 10;
    pelletEaten(state);
  } else if (maze.powerPellets.delete(k)) {
    state.score += 50;
    pelletEaten(state);
    state.frightLeft = frightSeconds(state.level);
    state.frightChain = 0;
    for (const g of ghostList(state)) if (g.state === 'normal') g.state = 'frightened';
  }
  if (state.fruit && sameTile(tile, state.fruit.tile)) {
    state.score += state.fruit.points;
    state.popups.push({ tile: { ...tile }, text: String(state.fruit.points), ttl: 1.5 });
    state.fruit = null;
  }
  if (maze.pellets.size + maze.powerPellets.size === 0) {
    state.status = 'levelclear';
    state.statusTimer = LEVELCLEAR_SECONDS;
  }
}

function pelletEaten(state: GameState): void {
  state.pelletsEaten += 1;
  if (state.pelletsEaten === FRUIT_THRESHOLDS[state.fruitsSpawned]) {
    state.fruit = { ...fruitForLevel(state.level), tile: { ...FRUIT_TILE }, secondsLeft: FRUIT_SECONDS };
    state.fruitsSpawned += 1;
  }
}

function checkCollisions(state: GameState): void {
  const p = actorPosition(state.pacman);
  for (const g of ghostList(state)) {
    if (g.state === 'house' || g.state === 'eaten') continue;
    const q = actorPosition(g);
    const dx = Math.abs(p.x - q.x);
    if (Math.hypot(Math.min(dx, state.maze.width - dx), p.y - q.y) >= COLLISION_DISTANCE) continue;
    if (g.state === 'frightened') {
      const points = 200 * 2 ** state.frightChain;
      state.frightChain += 1;
      state.score += points;
      g.state = 'eaten'; // a waiting ghost stays waiting; its next chooseAt uses the eyes' path home
      state.popups.push({ tile: occupiedTile(state, g), text: String(points), ttl: 1.5 });
    } else {
      state.status = 'dying';
      state.statusTimer = DYING_SECONDS;
      return;
    }
  }
}
