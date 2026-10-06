import type { ModelId } from '../shared/models';
import { fruitRoute, goalFor, greedyChoice, isTrap, movingToward, NEARBY_STEPS, optionFeatures, PELLET_REACH, type OptionFeatures } from './features';
import { REVERSE } from './maze';
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
  /** Which decision model answers (shared/models.ts); the server uses jev when it is missing. */
  model?: ModelId;
  state: Record<string, unknown>;
  questions: Record<string, ChoiceQuestion>;
}

export interface DecideResponse {
  /** The model the server called (missing from older servers). */
  model?: string;
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
  /** The model that answered, for decisions a model made (source 'jev'). */
  model?: string;
  reason?: string;
  /** Answer to a mid-corridor escape question rather than a junction choice. */
  escape?: boolean;
}

/** Name of a point's question in the System One request (Pac-Man can have two open at once). */
export const questionName = (point: DecisionPoint): string => (point.escape ? `${point.actor}_escape` : point.actor);

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * How the board is described to the model (the prompt lab compares them):
 * - grid: the whole maze as text rows plus per-route facts (the original prompt);
 * - facts: the same per-route facts, no maze picture;
 * - rich: no maze picture; where each ghost is relative to Pac-Man, and per-route safety first (who wins the race to
 *   the next junction, how many ways on are clear), then food;
 * - local: rich plus an 11x11 picture of the maze around Pac-Man.
 */
export type PromptStyle = 'grid' | 'facts' | 'rich' | 'local';
export const PROMPT_STYLES: readonly PromptStyle[] = ['grid', 'facts', 'rich', 'local'];

const LEGEND =
  '# wall, - ghost-house door, . pellet, o power pellet, F fruit, P Pac-Man, B Blinky, K Pinky, I Inky, C Clyde (lowercase = frightened, edible), e eyes of an eaten ghost';

/** The maze as text rows, with pellets, fruit and actors drawn in. */
function drawMaze(state: GameState): string[][] {
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
  put(occupiedTile(state, state.pacman), 'P');
  return grid;
}

const WINDOW = 5;

/** The 11x11 part of the maze centred on Pac-Man (off-board as blanks, the tunnel does not wrap). */
function localWindow(grid: string[][], at: Tile): string[] {
  const rows: string[] = [];
  for (let y = at.y - WINDOW; y <= at.y + WINDOW; y++) {
    let row = '';
    for (let x = at.x - WINDOW; x <= at.x + WINDOW; x++) row += grid[y]?.[x] ?? ' ';
    rows.push(row);
  }
  return rows;
}

export function summarizeState(state: GameState, style: PromptStyle = 'grid'): Record<string, unknown> {
  const { maze } = state;
  const pac = occupiedTile(state, state.pacman);
  const picture =
    style === 'grid'
      ? { maze: drawMaze(state).map((r) => r.join('')), legend: LEGEND }
      : style === 'local'
        ? { around_pacman: localWindow(drawMaze(state), pac), around_pacman_note: 'Pac-Man (P) is at the centre; up is the top row.', legend: LEGEND }
        : {};
  return {
    ...picture,
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

/** Where each ghost is from Pac-Man, by maze path: how far, which way, and whether it is closing in. */
export function threatSummary(state: GameState): string {
  const { maze } = state;
  const pac = occupiedTile(state, state.pacman);
  const heading = state.pacman.dir;
  const home = GHOST_IDS.filter((id) => state.ghosts[id].state === 'house').map((id) => ACTOR_NAMES[id]);
  const lines = GHOST_IDS.flatMap((id) => {
    const g = state.ghosts[id];
    if (g.state === 'house' || g.state === 'eaten') return [];
    const fromGhost = maze.distanceMap(occupiedTile(state, g));
    const d = fromGhost[maze.key(pac)];
    if (d < 0) return [];
    // The first step of the shortest path from Pac-Man to the ghost says which way it is.
    let way: Dir | null = null;
    let best = Infinity;
    for (const dir of maze.openDirs(pac)) {
      const v = fromGhost[maze.key(maze.neighbor(pac, dir))];
      if (v >= 0 && v < best) [way, best] = [dir, v];
    }
    const where = d === 0 || way === null ? 'right on you' : way === heading ? 'ahead of you' : way === REVERSE[heading] ? 'behind you' : `that way: ${way}`;
    const kind = g.state === 'frightened' ? ' (frightened, edible)' : '';
    return [`${ACTOR_NAMES[id]}${kind} ${plural(d, 'step')} away, ${where}, ${movingToward(state, g, pac) ? 'closing in' : 'moving away'}`];
  });
  if (home.length) lines.push(`${home.length > 1 ? `${home.slice(0, -1).join(', ')} and ${home[home.length - 1]} are` : `${home[0]} is`} still in the ghost house`);
  return `Ghosts now (path distance from you): ${lines.join('; ')}.`;
}

const rich = (style: PromptStyle) => style === 'rich' || style === 'local';

export function instructionsFor(
  state: GameState,
  point: DecisionPoint,
  feats: OptionFeatures[] = optionFeatures(state, point),
  style: PromptStyle = 'grid',
): string {
  const back = point.options.find((d) => d !== point.heading);
  const at = point.escape
    ? `You are running ${point.heading} through a corridor and ${(point.threats ?? []).map((id) => ACTOR_NAMES[id]).join(' and ')} ${point.threats?.length === 1 ? 'is' : 'are'} in the corridor ahead or can block the junction at its end before you get there. Keep going ${point.heading}, or turn back ${back} right now?`
    : `You are approaching junction (${point.tile.x},${point.tile.y}) heading ${point.heading}. Pick the direction to take there.`;
  if (point.actor === 'pacman') {
    // Spelling out one safe, reachable fruit route works far better than per-route distances: jev weighed
    // "cherry 14 steps away" against pellets and mostly let the fruit expire.
    const f = state.fruit;
    const marked = f && fruitRoute(state, point, feats);
    const fruit = !f
      ? ''
      : marked
        ? `A ${f.kind} worth ${f.points} points (as much as ${f.points / 10} pellets) is on the board and will disappear soon. One route is marked FRUIT: it is the fastest way to it that looks safe. ${
            state.frightLeft > 0 ? 'Hunt a frightened ghost you can reach first; otherwise take the FRUIT route.' : 'Take the FRUIT route.'
          } `
        : point.escape
          ? ''
          : `A ${f.kind} worth ${f.points} points is on the board but cannot be reached safely in time; ignore it. `;
    if (rich(style)) {
      return state.frightLeft > 0
        ? `You are Pac-Man. A power pellet is active for ${round1(state.frightLeft)} more seconds: frightened ghosts are worth 200, 400, 800 and 1600 points in a row. Hunt the nearest frightened ghost you can reach in time, but never run into a normal ghost (routes marked DANGER or BLOCKED). ${threatSummary(state)} ${fruit}${at}`
        : `You are Pac-Man. Clear the maze by eating every pellet without being caught; touching a non-frightened ghost costs a life. Safety first: avoid routes marked DANGER (a ghost is in that corridor) or BLOCKED (a ghost gets to the corridor's end no later than you), and prefer routes with more clear ways on past the next junction, so you cannot be cornered. Among safe routes, go where the food is. Power pellets make ghosts edible: take one when ghosts are closing in. ${threatSummary(state)} ${fruit}${at}`;
    }
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

/** Pac-Man's routes, safety first: who is in the corridor, who wins the race to its end, what is open beyond, then food. */
function richPacmanParts(state: GameState, f: OptionFeatures): string[] {
  const names = (ids: GhostId[]) => ids.map((id) => ACTOR_NAMES[id]).join(' and ');
  const parts: string[] = [];
  if (f.dangerInCorridor.length) {
    parts.push(`DANGER: ${names(f.dangerInCorridor)} in this corridor`);
  } else if (f.junctionGhost) {
    const margin = f.junctionGhost.steps - f.junctionSteps;
    const who = ACTOR_NAMES[f.junctionGhost.id];
    parts.push(
      margin < 0
        ? `BLOCKED: ${who} gets to the junction at the end ${plural(-margin, 'step')} before you`
        : margin === 0
          ? `BLOCKED: ${who} gets to the junction at the end at the same time as you`
          : `you get to the junction at the end ${plural(margin, 'step')} ahead of any ghost`,
    );
  } else {
    parts.push('no dangerous ghost can get to the junction at the end');
  }
  if (f.exitsAhead.total) parts.push(`from there ${f.exitsAhead.clear} of ${f.exitsAhead.total} ways on ${f.exitsAhead.clear === 1 ? 'is' : 'are'} clear`);
  parts.push(
    f.nearestDangerGhost === null
      ? 'no dangerous ghost reachable this way'
      : `${steps(f.nearestDangerGhost, 'nearest dangerous ghost')}, ${f.dangerApproaching ? 'coming toward you' : 'moving away'}`,
  );
  parts.push(`${plural(f.corridorPellets, 'pellet')} in this corridor, ${f.pelletsWithin} within ${PELLET_REACH} steps, ${steps(f.nearestPellet, 'nearest')}`);
  if (state.frightLeft === 0 && f.nearestPowerPellet !== null) parts.push(steps(f.nearestPowerPellet, 'power pellet'));
  if (state.frightLeft > 0 && f.nearestFrightenedGhost !== null) parts.push(steps(f.nearestFrightenedGhost, 'frightened ghost'));
  return parts;
}

export function criteriaFor(state: GameState, point: DecisionPoint, feats: OptionFeatures[], style: PromptStyle = 'grid'): Record<string, string> {
  const goal = goalFor(state, point.actor);
  const fruit = point.actor === 'pacman' ? fruitRoute(state, point, feats) : null;
  const names = (ids: GhostId[]) => ids.map((id) => ACTOR_NAMES[id]).join(' and ');
  return Object.fromEntries(
    feats.map((f) => {
      let parts: string[] = [];
      if (point.actor === 'pacman' && rich(style)) {
        parts = richPacmanParts(state, f);
        if (state.fruit && f.dir === fruit) {
          parts.unshift(`FRUIT — fastest safe-looking way to the ${state.fruit.kind} (${plural(f.fruitDistance!, 'step')}, worth ${state.fruit.points} points)`);
        }
      } else if (point.actor === 'pacman') {
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
        if (state.fruit && f.dir === fruit) {
          parts.unshift(`FRUIT — fastest safe-looking way to the ${state.fruit.kind} (${plural(f.fruitDistance!, 'step')}, worth ${state.fruit.points} points)`);
        }
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

export function buildRequest(state: GameState, batch: PendingQuestion[], style: PromptStyle = 'grid'): SystemOneRequest {
  return {
    state: summarizeState(state, style),
    questions: Object.fromEntries(
      batch.map(({ point, features }) => [
        questionName(point),
        { type: 'choice', instructions: instructionsFor(state, point, features, style), criteria: criteriaFor(state, point, features, style) },
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
