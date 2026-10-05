import { buildRequest, fallbackDecision, parseAnswer, questionName, type DecideResponse, type Decision, type PendingQuestion, type SystemOneRequest } from './brain';
import { DEFAULT_MODEL, type ModelId } from '../shared/models';
import { fruitRoute, optionFeatures, saferChoice } from './features';
import { decisionPoints, type Controls, type DecisionPoint, type GameState } from './sim';
import { ACTOR_IDS, type ActorId, type Dir } from './types';

export type Transport = (body: SystemOneRequest) => Promise<DecideResponse>;

export type SchedulerEvent =
  | { type: 'decision'; decision: Decision; latencyMs: number | null; fruitOnBoard: boolean }
  | { type: 'call'; /** Missing in games recorded before models could be chosen. */ model?: ModelId; actors: ActorId[]; latencyMs: number; usage: DecideResponse['usage']; costUsd: number | null; costEstimated?: boolean; traceId: string | null }
  | { type: 'stale'; actor: ActorId; key: string }
  /** An earlier `decision` that was never used; consumers should take it back out of their totals. */
  | { type: 'superseded'; decision: Decision }
  | { type: 'error'; message: string };

export interface SchedulerDeps {
  transport: Transport;
  now: () => number;
  onEvent: (e: SchedulerEvent) => void;
  timeoutMs?: number;
  maxInFlight?: number;
  /** Re-check Pac-Man's answer against the ghosts where they are now, at the junction (default on). */
  safetyCheck?: boolean;
  /** The decision model for each character (default: jev for all). Read on every request, so it can change mid-game. */
  modelFor?: (actor: ActorId) => ModelId;
  /** Actors this scheduler asks jev about, fixed or per game state (default: all). */
  actors?: readonly ActorId[] | ((state: GameState) => readonly ActorId[]);
  /**
   * In-flight request counter. Pass the same object to successive schedulers (one per game) so requests
   * still running from an earlier game keep counting against `maxInFlight`.
   */
  slots?: { inFlight: number };
}

interface Pending {
  q: PendingQuestion;
  sentAt: number | null; // null = queued, waiting for a free slot
  fruitOnBoard: boolean;
  /** Pac-Man's FRUIT route when the question was built; the answer is stale once that changes. */
  fruitRoute: Dir | null;
}

/**
 * Looks ahead to each jev-driven actor's next junction, asks jev in batches, and
 * hands the answers to the simulation through `decide`. Times out to a greedy fallback.
 */
export class Scheduler implements Controls {
  private readonly pending = new Map<string, Pending>();
  private readonly ready = new Map<string, { decision: Decision; fruitOnBoard: boolean; fruitRoute: Dir | null }>();
  /** Answers already handed to the sim whose question is still open (escape questions); never re-asked. */
  private readonly consumed = new Set<string>();
  private readonly slots: { inFlight: number };
  private readonly timeoutMs: number;
  private readonly maxInFlight: number;
  private readonly actors: readonly ActorId[] | ((state: GameState) => readonly ActorId[]);

  constructor(private readonly deps: SchedulerDeps) {
    this.timeoutMs = deps.timeoutMs ?? 2000;
    this.maxInFlight = deps.maxInFlight ?? 3;
    this.actors = deps.actors ?? ACTOR_IDS;
    this.slots = deps.slots ?? { inFlight: 0 };
  }

  update(state: GameState): void {
    const now = this.deps.now();
    const live = new Set<string>();
    const fruitOnBoard = state.fruit !== null;
    for (const id of typeof this.actors === 'function' ? this.actors(state) : this.actors) {
      for (const point of decisionPoints(state, id)) {
        live.add(point.key);
        // Pac-Man's routes and fallback depend on the fruit, which can appear or vanish without changing the key.
        if (id === 'pacman') {
          if (this.pending.get(point.key)?.fruitOnBoard === !fruitOnBoard) this.pending.delete(point.key);
          if (this.ready.get(point.key)?.fruitOnBoard === !fruitOnBoard) this.dropReady(point.key);
        }
        if (this.pending.has(point.key) || this.ready.has(point.key) || this.consumed.has(point.key)) continue;
        const features = optionFeatures(state, point);
        this.pending.set(point.key, {
          q: { point, features },
          sentAt: null,
          fruitOnBoard,
          fruitRoute: id === 'pacman' ? fruitRoute(state, point, features) : null,
        });
      }
    }
    for (const key of [...this.pending.keys()]) if (!live.has(key)) this.pending.delete(key);
    for (const key of [...this.ready.keys()]) if (!live.has(key)) this.dropReady(key);
    for (const key of [...this.consumed]) if (!live.has(key)) this.consumed.delete(key);

    for (const [key, p] of [...this.pending]) {
      if (p.sentAt !== null && now - p.sentAt > this.timeoutMs) this.resolve(key, fallbackDecision(state, p.q, 'timeout'), null);
    }

    // One request per model: a System One request names a single model.
    const byModel = new Map<ModelId, Pending[]>();
    for (const p of this.pending.values()) {
      if (p.sentAt !== null) continue;
      const model = this.deps.modelFor?.(p.q.point.actor) ?? DEFAULT_MODEL;
      byModel.set(model, [...(byModel.get(model) ?? []), p]);
    }
    for (const [model, batch] of byModel) {
      if (this.slots.inFlight >= this.maxInFlight) break;
      this.send(state, batch, now, model);
    }
  }

  decide(point: DecisionPoint, state: GameState): Dir | null {
    const r = this.ready.get(point.key);
    if (!r) return null;
    this.ready.delete(point.key);
    let d = r.decision;
    // Fruit can appear or expire inside the very step that reaches the junction, after the last update(), and
    // while Pac-Man waits for an answer the fruit can drift out of reach. Either way the answer is stale.
    const features = point.actor === 'pacman' && (r.fruitOnBoard || state.fruit) ? optionFeatures(state, point) : null;
    if (features && (r.fruitOnBoard !== (state.fruit !== null) || fruitRoute(state, point, features) !== r.fruitRoute)) {
      this.deps.onEvent({ type: 'superseded', decision: d });
      d = fallbackDecision(state, { point, features }, 'fruit changed');
      this.deps.onEvent({ type: 'decision', decision: d, latencyMs: null, fruitOnBoard: state.fruit !== null });
    }
    if (point.actor === 'pacman' && d.source === 'jev' && this.deps.safetyCheck !== false) {
      // Escape answers are positional (keep going / turn back); map them onto the options at hand.
      const asked = d.options;
      const now = point.escape ? point.options : asked;
      const choice = now[asked.indexOf(d.choice)] ?? d.choice;
      const probabilities = Object.fromEntries(asked.map((o, i) => [now[i], d.probabilities[o]]));
      const safer = saferChoice(choice, probabilities, features ?? optionFeatures(state, point));
      if (safer) {
        // Same decision, new direction: consumers count it as an override, not as another decision.
        d = { ...d, choice: point.escape ? asked[now.indexOf(safer)] : safer, vetoed: d.choice };
        this.deps.onEvent({ type: 'decision', decision: d, latencyMs: null, fruitOnBoard: state.fruit !== null });
      }
    }
    if (!point.escape) return d.choice;
    this.consumed.add(point.key);
    // Escape answers mean "keep going" or "turn back"; Pac-Man may have rounded a corner since.
    return d.choice === d.options[0] ? point.options[0] : point.options[1];
  }

  reset(): void {
    this.pending.clear();
    this.ready.clear();
    this.consumed.clear();
  }

  private send(state: GameState, batch: Pending[], now: number, model: ModelId): void {
    for (const p of batch) p.sentAt = now;
    this.slots.inFlight += 1;
    const isCurrent = (p: Pending) => this.pending.get(p.q.point.key) === p;
    this.deps
      .transport({ model, ...buildRequest(state, batch.map((p) => p.q)) })
      .then(
        (res) => {
          this.deps.onEvent({
            type: 'call',
            model,
            actors: batch.map((p) => p.q.point.actor),
            latencyMs: res.latencyMs,
            usage: res.usage,
            costUsd: res.costUsd,
            costEstimated: res.costEstimated === true,
            traceId: res.traceId,
          });
          for (const p of batch) {
            if (!isCurrent(p)) {
              this.deps.onEvent({ type: 'stale', actor: p.q.point.actor, key: p.q.point.key });
              continue;
            }
            const parsed = parseAnswer(res.answers[questionName(p.q.point)], p.q);
            const decision = parsed ? { ...parsed, model } : fallbackDecision(state, p.q, 'invalid answer');
            this.resolve(p.q.point.key, decision, res.latencyMs);
          }
        },
        (err: unknown) => {
          this.deps.onEvent({ type: 'error', message: err instanceof Error ? err.message : String(err) });
          for (const p of batch) if (isCurrent(p)) this.resolve(p.q.point.key, fallbackDecision(state, p.q, 'error'), null);
        },
      )
      .finally(() => {
        this.slots.inFlight -= 1;
      });
  }

  /** Discard an answer that was announced as a decision but will never be used. */
  private dropReady(key: string): void {
    const r = this.ready.get(key);
    if (!r) return;
    this.ready.delete(key);
    this.deps.onEvent({ type: 'superseded', decision: r.decision });
  }

  private resolve(key: string, decision: Decision, latencyMs: number | null): void {
    const p = this.pending.get(key);
    if (!p) return;
    this.pending.delete(key);
    this.ready.set(key, { decision, fruitOnBoard: p.fruitOnBoard, fruitRoute: p.fruitRoute });
    this.deps.onEvent({ type: 'decision', decision, latencyMs, fruitOnBoard: p.fruitOnBoard });
  }
}
