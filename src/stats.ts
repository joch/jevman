import { DEFAULT_MODEL } from '../shared/models';
import { ACTOR_NAMES } from './brain';
import { REVERSE } from './maze';
import type { SchedulerEvent } from './scheduler';
import { escapePoint, type GameState } from './sim';
import { sameTile, type GhostId, type Tile } from './types';

export type DeathContext = 'waiting at junction' | 'ghost ahead in corridor' | 'ghost from behind' | 'at/near junction';

export interface Death {
  ghost: GhostId | null;
  context: DeathContext;
  /** Seconds of play when it happened. */
  seconds: number;
}

export interface GameSummary {
  score: number;
  level: number;
  seconds: number;
  pellets: number;
  ghostsEaten: number;
  fruit: { kind: string; points: number }[];
  deaths: Death[];
  jev: {
    calls: number;
    decisions: number;
    fallbacks: number;
    meanLatencyMs: number | null;
    meanConfidence: number | null;
    /** null when no call reported a cost. */
    costUsd: number | null;
    costEstimated: boolean;
    /** Requests that failed (signed out, empty wallet, timeouts, errors). */
    errors: number;
    /** jev picks the safety check replaced because ghosts had moved into the way. */
    overrides: number;
    /** The models that made decisions this game, in the order they first did. */
    models: string[];
  };
}

const GHOST_POINTS = new Set(['200', '400', '800', '1600']);

/**
 * In the frame of contact the ghost is always in Pac-Man's corridor. It only counts as "ran into" or "caught up from
 * behind" if it had been there at least this long, time enough to turn back; otherwise it cut him off at a junction.
 */
export const REACT_SECONDS = 0.4;

/** What Pac-Man was doing in the frame before he was caught (for keyboard or jev play alike). */
export function deathContext(state: GameState): DeathContext | null {
  if (state.status !== 'playing') return null;
  const p = state.pacman;
  // A keyboard Pac-Man also "waits" when he stops at a wall; only a jev Pac-Man waits for an answer.
  if (p.waiting && state.pacmanControl === 'jev') return 'waiting at junction';
  const asJev = { ...state, pacmanControl: 'jev' as const };
  if (escapePoint(asJev)) return 'ghost ahead in corridor';
  // The same position, facing the other way.
  const back = p.progress > 0
    ? { ...p, tile: state.maze.neighbor(p.tile, p.dir), dir: REVERSE[p.dir], progress: 1 - p.progress }
    : { ...p, dir: REVERSE[p.dir] };
  if (escapePoint({ ...asJev, pacman: back })) return 'ghost from behind';
  return 'at/near junction';
}

export function deathLabel(d: Death): string {
  const who = d.ghost ? ACTOR_NAMES[d.ghost] : 'a ghost';
  switch (d.context) {
    case 'waiting at junction':
      return `caught by ${who} while waiting for the model at a junction`;
    case 'ghost ahead in corridor':
      return `ran into ${who} in a corridor`;
    case 'ghost from behind':
      return `${who} caught up from behind`;
    case 'at/near junction':
      return `${who} cut him off at a junction`;
  }
}

/**
 * Per-game statistics for the game-over screen. The game loop calls beforeStep/afterStep around each
 * sim step and forwards scheduler events; nothing here changes the game.
 */
export class GameStats {
  private seconds = 0;
  private pellets = 0;
  private ghostsEaten = 0;
  private readonly fruit: { kind: string; points: number }[] = [];
  private readonly deaths: Death[] = [];
  private calls = 0;
  private decisions = 0;
  private fallbacks = 0;
  private latency = { sum: 0, n: 0 };
  private confidence = { sum: 0, n: 0 };
  private cost = { sum: 0, known: false };
  private costEstimated = false;
  private errors = 0;
  private overrides = 0;
  private readonly models = new Set<string>();
  /** This life's recent situations, oldest first, trimmed to a little more than REACT_SECONDS. */
  private recent: { seconds: number; context: DeathContext | null }[] = [];
  private before: {
    status: GameState['status'];
    pelletsEaten: number;
    score: number;
    fruit: { kind: string; points: number; tile: Tile } | null;
    popups: Set<GameState['popups'][number]>;
    context: DeathContext | null;
  } | null = null;

  beforeStep(state: GameState): void {
    this.before = {
      status: state.status,
      pelletsEaten: state.pelletsEaten,
      score: state.score,
      fruit: state.fruit ? { kind: state.fruit.kind, points: state.fruit.points, tile: { ...state.fruit.tile } } : null,
      popups: new Set(state.popups),
      context: deathContext(state),
    };
  }

  afterStep(state: GameState, dt: number): void {
    const b = this.before;
    if (!b) return;
    if (b.status === 'playing') this.seconds += dt;
    // A level clear resets pelletsEaten to 0.
    if (state.pelletsEaten > b.pelletsEaten) this.pellets += state.pelletsEaten - b.pelletsEaten;
    // Every ghost eaten leaves a 200/400/800/1600 popup (fruit values never collide), even when the same frame
    // later eats a power pellet and resets frightChain.
    this.ghostsEaten += state.popups.filter((p) => !b.popups.has(p) && GHOST_POINTS.has(p.text)).length;
    // Eating fruit leaves a points popup on its tile; a fruit that merely expired does not.
    const fruit = b.fruit;
    if (fruit && !state.fruit && state.popups.some((p) => !b.popups.has(p) && p.text === String(fruit.points) && sameTile(p.tile, fruit.tile))) {
      this.fruit.push({ kind: fruit.kind, points: fruit.points });
    }
    if (b.status === 'playing') {
      // Stamped with the start of the step: the situation held from then on.
      this.recent.push({ seconds: this.seconds - dt, context: b.context });
      while (this.recent.length > 1 && this.recent[1].seconds <= this.seconds - REACT_SECONDS - 0.5) this.recent.shift();
    }
    if (b.status === 'playing' && state.status === 'dying') {
      let context = b.context ?? 'at/near junction';
      if (context === 'ghost ahead in corridor' || context === 'ghost from behind') {
        let since = this.seconds;
        for (let i = this.recent.length - 1; i >= 0 && this.recent[i].context === context; i--) since = this.recent[i].seconds;
        if (this.seconds - since < REACT_SECONDS) context = 'at/near junction';
      }
      this.deaths.push({ ghost: state.caughtBy, context, seconds: Math.round(this.seconds * 10) / 10 });
      this.recent = [];
    }
    this.before = null;
  }

  onSchedulerEvent(e: SchedulerEvent): void {
    if (e.type === 'call') {
      this.calls += 1;
      // Every model that was called (and billed), named as listed: TypeSafe's own id for jev reads as jev.
      if (e.model) this.models.add(e.model === 'jev-1.13.0' ? DEFAULT_MODEL : e.model);
      if (Number.isFinite(e.latencyMs)) {
        this.latency.sum += e.latencyMs;
        this.latency.n += 1;
      }
      if (e.costUsd !== null && Number.isFinite(e.costUsd)) {
        this.cost.sum += e.costUsd;
        this.cost.known = true;
      }
      if (e.costEstimated) this.costEstimated = true;
    } else if (e.type === 'error') {
      this.errors += 1;
    } else if (e.type === 'decision' && e.decision.vetoed) {
      this.overrides += 1;
    } else if (e.type === 'decision' || e.type === 'superseded') {
      const sign = e.type === 'decision' ? 1 : -1;
      this.decisions += sign;
      if (e.decision.source === 'fallback') this.fallbacks += sign;
      else if (e.decision.confidence !== null && Number.isFinite(e.decision.confidence)) {
        this.confidence.sum += sign * e.decision.confidence;
        this.confidence.n += sign;
      }
    }
  }

  summary(state: GameState): GameSummary {
    const round = (n: number, places: number) => Math.round(n * 10 ** places) / 10 ** places;
    return {
      score: state.score,
      level: state.level,
      seconds: round(this.seconds, 1),
      pellets: this.pellets,
      ghostsEaten: this.ghostsEaten,
      fruit: [...this.fruit],
      deaths: [...this.deaths],
      jev: {
        calls: this.calls,
        decisions: this.decisions,
        fallbacks: this.fallbacks,
        meanLatencyMs: this.latency.n ? Math.round(this.latency.sum / this.latency.n) : null,
        meanConfidence: this.confidence.n ? round(this.confidence.sum / this.confidence.n, 2) : null,
        costUsd: this.cost.known ? round(this.cost.sum, 6) : null,
        costEstimated: this.costEstimated,
        errors: this.errors,
        overrides: this.overrides,
        models: [...this.models],
      },
    };
  }
}
