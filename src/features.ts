import { SCATTER_CORNERS } from './layout';
import { DIR_VEC, REVERSE } from './maze';
import { occupiedTile, type DecisionPoint, type GameState } from './sim';
import { GHOST_IDS, sameTile, type ActorId, type Dir, type GhostId, type Tile } from './types';

export type GoalKind = 'pacman' | 'ambush' | 'flank' | 'corner' | 'flee' | 'eat' | 'hunt';

export interface Goal {
  kind: GoalKind;
  label: string;
  target: Tile | null;
}

export interface OptionFeatures {
  dir: Dir;
  /** Steps to the actor's current goal via this option (Pac-Man: nearest pellet, or frightened ghost when hunting). */
  goalDistance: number | null;
  /** Ghosts only: steps to Pac-Man via this option. */
  pacmanDistance: number | null;
  nearestPellet: number | null;
  /** Pellets on the corridor this option leads into, up to and including the next junction. */
  corridorPellets: number;
  nearestDangerGhost: number | null;
  /** Normal (non-frightened) ghosts other than the actor standing on that corridor. */
  dangerInCorridor: GhostId[];
  nearestFrightenedGhost: number | null;
  fruitDistance: number | null;
  nearestPowerPellet: number | null;
  /** Whether the nearest dangerous ghost on this route is moving toward it. */
  dangerApproaching: boolean;
  /** Dangerous ghosts within NEARBY_STEPS via this route. */
  dangerNearby: number;
  /** Steps to the junction where this option's corridor ends. */
  junctionSteps: number;
  /** The dangerous ghost that can reach that junction fastest, and how many steps it needs. */
  junctionGhost: { id: GhostId; steps: number } | null;
}

const CORRIDOR_LIMIT = 40;
const CLYDE_SHY_DISTANCE = 8;
export const NEARBY_STEPS = 8;

/** A ghost can get to the end of this route's corridor no later than Pac-Man. */
export const isTrap = (f: OptionFeatures): boolean => f.junctionGhost !== null && f.junctionGhost.steps <= f.junctionSteps;

export function goalFor(state: GameState, id: ActorId): Goal {
  if (id === 'pacman') {
    return state.frightLeft > 0
      ? { kind: 'hunt', label: 'frightened ghost', target: null }
      : { kind: 'eat', label: 'pellet', target: null };
  }
  const { maze } = state;
  const ghost = state.ghosts[id];
  const pac = occupiedTile(state, state.pacman);
  if (ghost.state === 'frightened') return { kind: 'flee', label: 'Pac-Man', target: pac };
  const corner: Goal = { kind: 'corner', label: 'home corner', target: SCATTER_CORNERS[id] };
  if (state.mode === 'scatter') return corner;
  const ahead = (n: number): Tile => {
    const v = DIR_VEC[state.pacman.dir];
    return { x: pac.x + v.x * n, y: pac.y + v.y * n };
  };
  switch (id) {
    case 'blinky':
      return { kind: 'pacman', label: 'Pac-Man', target: pac };
    case 'pinky':
      return { kind: 'ambush', label: 'ambush point ahead of Pac-Man', target: maze.nearestWalkable(ahead(4)) };
    case 'inky': {
      const pivot = ahead(2);
      const b = occupiedTile(state, state.ghosts.blinky);
      return {
        kind: 'flank',
        label: 'flanking point',
        target: maze.nearestWalkable({ x: 2 * pivot.x - b.x, y: 2 * pivot.y - b.y }),
      };
    }
    case 'clyde': {
      const d = maze.distances(occupiedTile(state, ghost))[maze.key(pac)];
      return d >= 0 && d <= CLYDE_SHY_DISTANCE ? corner : { kind: 'pacman', label: 'Pac-Man', target: pac };
    }
  }
}

export function optionFeatures(state: GameState, point: DecisionPoint): OptionFeatures[] {
  const { maze } = state;
  const goal = goalFor(state, point.actor);
  const pac = occupiedTile(state, state.pacman);
  const others = GHOST_IDS.filter((id) => id !== point.actor).map((id) => state.ghosts[id]);
  const danger = others.filter((g) => g.state === 'normal');
  const frightened = others.filter((g) => g.state === 'frightened');
  const pelletTiles = [...maze.pellets, ...maze.powerPellets].map((k) => maze.fromKey(k));
  const powerTiles = [...maze.powerPellets].map((k) => maze.fromKey(k));

  return point.options.map((dir) => {
    const start = maze.neighbor(point.tile, dir);
    const dist = maze.distances(start, point.tile);
    const steps = (t: Tile): number | null => {
      const v = dist[maze.key(t)];
      return v < 0 ? null : v + 1;
    };
    const nearest = (tiles: Tile[]): number | null => {
      let best: number | null = null;
      for (const t of tiles) {
        const s = steps(t);
        if (s !== null && (best === null || s < best)) best = s;
      }
      return best;
    };
    const corridor = corridorFrom(state, start, dir);
    const junction = corridor[corridor.length - 1];
    const toJunction = maze.distanceMap(junction);
    let junctionGhost: OptionFeatures['junctionGhost'] = null;
    for (const g of danger) {
      const d = toJunction[maze.key(occupiedTile(state, g))];
      if (d >= 0 && (junctionGhost === null || d < junctionGhost.steps)) junctionGhost = { id: g.id, steps: d };
    }
    const dangerSteps = danger
      .map((g) => ({ g, tile: occupiedTile(state, g), steps: steps(occupiedTile(state, g)) }))
      .filter((x): x is { g: (typeof danger)[number]; tile: Tile; steps: number } => x.steps !== null)
      .sort((a, b) => a.steps - b.steps);
    const closest = dangerSteps[0];
    const closestNext = closest ? steps(maze.neighbor(closest.tile, closest.g.dir)) : null;
    const nearestPellet = nearest(pelletTiles);
    const nearestFrightenedGhost = nearest(frightened.map((g) => occupiedTile(state, g)));
    const goalDistance = goal.target
      ? steps(goal.target)
      : goal.kind === 'hunt'
        ? (nearestFrightenedGhost ?? nearestPellet)
        : nearestPellet;
    return {
      dir,
      goalDistance,
      pacmanDistance: point.actor === 'pacman' ? null : steps(pac),
      nearestPellet,
      corridorPellets: corridor.filter((t) => maze.pellets.has(maze.key(t)) || maze.powerPellets.has(maze.key(t))).length,
      nearestDangerGhost: nearest(danger.map((g) => occupiedTile(state, g))),
      dangerInCorridor: danger.filter((g) => corridor.some((t) => sameTile(t, occupiedTile(state, g)))).map((g) => g.id),
      nearestFrightenedGhost,
      fruitDistance: state.fruit ? steps(state.fruit.tile) : null,
      nearestPowerPellet: nearest(powerTiles),
      dangerApproaching: closest !== undefined && closestNext !== null && closestNext < closest.steps,
      dangerNearby: dangerSteps.filter((x) => x.steps <= NEARBY_STEPS).length,
      junctionSteps: corridor.length,
      junctionGhost,
    };
  });
}

function corridorFrom(state: GameState, start: Tile, heading: Dir): Tile[] {
  const tiles: Tile[] = [];
  let tile = start;
  let dir = heading;
  for (let i = 0; i < CORRIDOR_LIMIT; i++) {
    tiles.push(tile);
    const ahead = state.maze.openDirs(tile).filter((d) => d !== REVERSE[dir]);
    if (ahead.length !== 1) break;
    dir = ahead[0];
    tile = state.maze.neighbor(tile, dir);
  }
  return tiles;
}

/** Deterministic stand-in used when jev cannot answer in time. */
export function greedyChoice(state: GameState, point: DecisionPoint, feats: OptionFeatures[]): Dir {
  const lowest = (pool: OptionFeatures[], score: (f: OptionFeatures) => number) =>
    pool.reduce((best, f) => (score(f) < score(best) ? f : best)).dir;
  const or = (v: number | null, missing: number) => v ?? missing;

  if (point.actor !== 'pacman') {
    return goalFor(state, point.actor).kind === 'flee'
      ? lowest(feats, (f) => -or(f.pacmanDistance, 999))
      : lowest(feats, (f) => or(f.goalDistance, 999));
  }
  const safe = feats.filter((f) => f.dangerInCorridor.length === 0 && or(f.nearestDangerGhost, 999) > 2 && !isTrap(f));
  const pool = safe.length ? safe : feats;
  if (state.frightLeft > 0 && pool.some((f) => f.nearestFrightenedGhost !== null)) {
    return lowest(pool, (f) => or(f.nearestFrightenedGhost, 999));
  }
  return lowest(pool, (f) => or(f.nearestPellet, 999));
}
