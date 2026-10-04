import { goalFor, greedyChoice, isTrap, NEARBY_STEPS, type OptionFeatures } from './features';
import { occupiedTile, type DecisionPoint, type GameState } from './sim';
import { GHOST_IDS, type ActorId, type Dir, type GhostId, type Tile } from './types';

export const ACTOR_NAMES: Record<ActorId, string> = {
  pacman: 'Pac-Man',
  blinky: 'Blinky',
  pinky: 'Pinky',
  inky: 'Inky',
  clyde: 'Clyde',
};

const LETTERS: Record<GhostId, string> = { blinky: 'B', pinky: 'K', inky: 'I', clyde: 'C' };

const PERSONA: Record<GhostId, string> = {
  blinky: 'You are Blinky, the red ghost. You are relentless: always close the distance to Pac-Man directly.',
  pinky: 'You are Pinky, the pink ghost. You ambush: head for the spot about 4 tiles ahead of Pac-Man to cut him off.',
  inky: 'You are Inky, the cyan ghost. You flank: approach Pac-Man from the side opposite Blinky to trap him between you.',
  clyde:
    'You are Clyde, the orange ghost. You chase Pac-Man while he is far away, but within 8 tiles you lose your nerve and retreat to your home corner (bottom-left).',
};

export interface PendingQuestion {
  point: DecisionPoint;
  features: OptionFeatures[];
}

export interface ChoiceQuestion {
  type: 'choice';
  instructions: string;
  criteria: Record<string, string>;
}

export interface SystemOneRequest {
  state: Record<string, unknown>;
  questions: Record<string, ChoiceQuestion>;
}

export interface DecideResponse {
  answers: Record<string, unknown>;
  usage: { input_tokens: number; output_tokens: number };
  latencyMs: number;
  costUsd: number | null;
  /** True when costUsd is estimated from token usage (TypeSafe's API sends no cost). */
  costEstimated?: boolean;
  traceId: string | null;
}

export interface Decision {
  actor: ActorId;
  key: string;
  tile: Tile;
  choice: Dir;
  options: Dir[];
  probabilities: Partial<Record<Dir, number>>;
  confidence: number | null;
  source: 'jev' | 'fallback';
  reason?: string;
  /** Answer to a mid-corridor escape question rather than a junction choice. */
  escape?: boolean;
}

/** Name of a point's question in the System One request (Pac-Man can have two open at once). */
export const questionName = (point: DecisionPoint): string => (point.escape ? `${point.actor}_escape` : point.actor);

const round1 = (n: number) => Math.round(n * 10) / 10;

export function summarizeState(state: GameState): Record<string, unknown> {
  const { maze } = state;
  const grid = state.layout.map((row, y) =>
    [...row].map((c, x) => {
      const k = maze.key({ x, y });
      if (c === '.') return maze.pellets.has(k) ? '.' : ' ';
      if (c === 'o') return maze.powerPellets.has(k) ? 'o' : ' ';
      return c === '_' ? '#' : c;
    }),
  );
  const put = (t: Tile, ch: string) => {
    grid[t.y][t.x] = ch;
  };
  if (state.fruit) put(state.fruit.tile, 'F');
  for (const id of GHOST_IDS) {
    const g = state.ghosts[id];
    if (g.state === 'house') continue;
    put(occupiedTile(state, g), g.state === 'normal' ? LETTERS[id] : g.state === 'frightened' ? LETTERS[id].toLowerCase() : 'e');
  }
  const pac = occupiedTile(state, state.pacman);
  put(pac, 'P');
  return {
    maze: grid.map((r) => r.join('')),
    legend:
      '# wall, - ghost-house door, . pellet, o power pellet, F fruit, P Pac-Man, B Blinky, K Pinky, I Inky, C Clyde (lowercase = frightened, edible), e eyes of an eaten ghost',
    mode: state.mode,
    frightened_seconds_left: round1(state.frightLeft),
    pacman: { x: pac.x, y: pac.y, dir: state.pacman.dir },
    ghosts: Object.fromEntries(
      GHOST_IDS.map((id) => {
        const g = state.ghosts[id];
        const t = occupiedTile(state, g);
        return [id, { x: t.x, y: t.y, dir: g.dir, state: g.state }];
      }),
    ),
    pellets_left: maze.pellets.size + maze.powerPellets.size,
    lives: state.lives,
    level: state.level,
    score: state.score,
    fruit: state.fruit
      ? { kind: state.fruit.kind, points: state.fruit.points, x: state.fruit.tile.x, y: state.fruit.tile.y, seconds_left: round1(state.fruit.secondsLeft) }
      : null,
  };
}

export function instructionsFor(state: GameState, point: DecisionPoint): string {
  const back = point.options.find((d) => d !== point.heading);
  const at = point.escape
    ? `You are running ${point.heading} through a corridor and ${(point.threats ?? []).map((id) => ACTOR_NAMES[id]).join(' and ')} ${point.threats?.length === 1 ? 'is' : 'are'} in the corridor ahead or can block the junction at its end before you get there. Keep going ${point.heading}, or turn back ${back} right now?`
    : `You are approaching junction (${point.tile.x},${point.tile.y}) heading ${point.heading}. Pick the direction to take there.`;
  if (point.actor === 'pacman') {
    const fruit = state.fruit
      ? `A ${state.fruit.kind} worth ${state.fruit.points} points is on the board for ${round1(state.fruit.secondsLeft)} more seconds; it is worth a detour only if you can reach it in time without passing a ghost. `
      : '';
    return state.frightLeft > 0
      ? `You are Pac-Man. A power pellet is active for ${round1(state.frightLeft)} more seconds: frightened ghosts (lowercase letters) are worth 200, 400, 800 and 1600 points in a row. Hunt the nearest frightened ghost if you can reach it in time, but never run into a normal ghost. ${fruit}${at}`
      : `You are Pac-Man. Clear the maze by eating every pellet while staying away from the ghosts; touching a non-frightened ghost costs a life. Power pellets (o) make ghosts frightened and edible, so take one when ghosts are closing in. Never pick a route marked DANGER or TRAP unless every route is; prefer routes where ghosts are moving away. ${fruit}${at}`;
  }
  const ghost = state.ghosts[point.actor];
  if (ghost.state === 'frightened') {
    return `You are ${ACTOR_NAMES[point.actor]}, a ghost. You are frightened for ${round1(state.frightLeft)} more seconds and Pac-Man can eat you. Flee: pick the route that keeps you farthest from Pac-Man. ${at}`;
  }
  if (state.mode === 'scatter') {
    return `${PERSONA[point.actor]} Right now it is scatter time: head back to your home corner instead of chasing. ${at}`;
  }
  return `${PERSONA[point.actor]} ${at}`;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const steps = (n: number | null, what: string) => (n === null ? `${what} not reachable this way` : `${what} ${plural(n, 'step')} away`);

export function criteriaFor(state: GameState, point: DecisionPoint, feats: OptionFeatures[]): Record<string, string> {
  const goal = goalFor(state, point.actor);
  const names = (ids: GhostId[]) => ids.map((id) => ACTOR_NAMES[id]).join(' and ');
  return Object.fromEntries(
    feats.map((f) => {
      const parts: string[] = [];
      if (point.actor === 'pacman') {
        parts.push(steps(f.nearestPellet, 'nearest pellet'));
        parts.push(`${plural(f.corridorPellets, 'pellet')} in the next corridor`);
        parts.push(
          f.nearestDangerGhost === null
            ? 'no dangerous ghost reachable this way'
            : `${steps(f.nearestDangerGhost, 'nearest dangerous ghost')}, ${f.dangerApproaching ? 'coming toward you' : 'moving away'}`,
        );
        if (f.dangerNearby >= 2) parts.push(`${f.dangerNearby} dangerous ghosts within ${NEARBY_STEPS} steps`);
        if (f.dangerInCorridor.length) parts.push(`DANGER: ${names(f.dangerInCorridor)} in this corridor`);
        if (f.junctionGhost && isTrap(f)) {
          parts.push(`TRAP: ${ACTOR_NAMES[f.junctionGhost.id]} can reach the next junction in ${plural(f.junctionGhost.steps, 'step')}, you need ${f.junctionSteps}`);
        } else if (f.junctionGhost) {
          parts.push(`you reach the next junction in ${plural(f.junctionSteps, 'step')}, ${plural(f.junctionGhost.steps - f.junctionSteps, 'step')} before any ghost`);
        }
        if (state.frightLeft === 0 && f.nearestPowerPellet !== null) parts.push(steps(f.nearestPowerPellet, 'power pellet'));
        if (state.frightLeft > 0 && f.nearestFrightenedGhost !== null) parts.push(steps(f.nearestFrightenedGhost, 'frightened ghost'));
        if (state.fruit && f.fruitDistance !== null) parts.push(steps(f.fruitDistance, `${state.fruit.kind} (${state.fruit.points} pts)`));
      } else if (goal.kind === 'flee') {
        parts.push(`${steps(f.pacmanDistance, 'Pac-Man')} via this route (farther is safer)`);
      } else {
        parts.push(`${steps(f.goalDistance, goal.label)} via this route`);
        if (goal.kind !== 'pacman') parts.push(steps(f.pacmanDistance, 'Pac-Man'));
        if (f.dangerInCorridor.length) parts.push(`passes ${names(f.dangerInCorridor)}`);
      }
      return [f.dir, `Go ${f.dir}: ${parts.join('; ')}`];
    }),
  );
}

export function buildRequest(state: GameState, batch: PendingQuestion[]): SystemOneRequest {
  return {
    state: summarizeState(state),
    questions: Object.fromEntries(
      batch.map(({ point, features }) => [
        questionName(point),
        { type: 'choice', instructions: instructionsFor(state, point), criteria: criteriaFor(state, point, features) },
      ]),
    ),
  };
}

export function parseAnswer(answer: unknown, q: PendingQuestion): Decision | null {
  if (!answer || typeof answer !== 'object') return null;
  const a = answer as { type?: unknown; choice?: unknown; confidence?: unknown; probabilities?: unknown };
  if (a.type !== 'choice' || typeof a.choice !== 'string') return null;
  const choice = a.choice as Dir;
  if (!q.point.options.includes(choice)) return null;
  const raw = (a.probabilities && typeof a.probabilities === 'object' ? a.probabilities : {}) as Record<string, unknown>;
  const probabilities: Partial<Record<Dir, number>> = {};
  for (const d of q.point.options) if (typeof raw[d] === 'number') probabilities[d] = raw[d] as number;
  return {
    actor: q.point.actor,
    key: q.point.key,
    tile: q.point.tile,
    choice,
    options: q.point.options,
    probabilities,
    confidence: typeof a.confidence === 'number' ? a.confidence : null,
    source: 'jev',
    ...(q.point.escape ? { escape: true } : {}),
  };
}

export function fallbackDecision(state: GameState, q: PendingQuestion, reason: string): Decision {
  return {
    actor: q.point.actor,
    key: q.point.key,
    tile: q.point.tile,
    choice: greedyChoice(state, q.point, q.features),
    options: q.point.options,
    probabilities: {},
    confidence: null,
    source: 'fallback',
    reason,
    ...(q.point.escape ? { escape: true } : {}),
  };
}
