import { buildRequest, fallbackDecision, parseAnswer, questionName, type DecideResponse, type Decision, type PendingQuestion, type SystemOneRequest } from './brain';
import { optionFeatures } from './features';
import { decisionPoints, type Controls, type DecisionPoint, type GameState } from './sim';
import { ACTOR_IDS, type ActorId, type Dir } from './types';

export type Transport = (body: SystemOneRequest) => Promise<DecideResponse>;

export type SchedulerEvent =
  | { type: 'decision'; decision: Decision; latencyMs: number | null; fruitOnBoard: boolean }
  | { type: 'call'; actors: ActorId[]; latencyMs: number; usage: DecideResponse['usage']; costUsd: number | null; traceId: string | null }
  | { type: 'stale'; actor: ActorId; key: string }
  | { type: 'error'; message: string };

export interface SchedulerDeps {
  transport: Transport;
  now: () => number;
  onEvent: (e: SchedulerEvent) => void;
  timeoutMs?: number;
  maxInFlight?: number;
  /** Actors this scheduler asks jev about (default: all). */
  actors?: readonly ActorId[];
}

interface Pending {
  q: PendingQuestion;
  sentAt: number | null; // null = queued, waiting for a free slot
  fruitOnBoard: boolean;
}

/**
 * Looks ahead to each jev-driven actor's next junction, asks jev in batches, and
 * hands the answers to the simulation through `decide`. Times out to a greedy fallback.
 */
export class Scheduler implements Controls {
  private readonly pending = new Map<string, Pending>();
  private readonly ready = new Map<string, Decision>();
  /** Answers already handed to the sim whose question is still open (escape questions); never re-asked. */
  private readonly consumed = new Set<string>();
  private inFlight = 0;
  private readonly timeoutMs: number;
  private readonly maxInFlight: number;
  private readonly actors: readonly ActorId[];

  constructor(private readonly deps: SchedulerDeps) {
    this.timeoutMs = deps.timeoutMs ?? 2000;
    this.maxInFlight = deps.maxInFlight ?? 3;
    this.actors = deps.actors ?? ACTOR_IDS;
  }

  update(state: GameState): void {
    const now = this.deps.now();
    const live = new Set<string>();
    for (const id of this.actors) {
      for (const point of decisionPoints(state, id)) {
        live.add(point.key);
        if (this.pending.has(point.key) || this.ready.has(point.key) || this.consumed.has(point.key)) continue;
        this.pending.set(point.key, {
          q: { point, features: optionFeatures(state, point) },
          sentAt: null,
          fruitOnBoard: state.fruit !== null,
        });
      }
    }
    for (const key of [...this.pending.keys()]) if (!live.has(key)) this.pending.delete(key);
    for (const key of [...this.ready.keys()]) if (!live.has(key)) this.ready.delete(key);
    for (const key of [...this.consumed]) if (!live.has(key)) this.consumed.delete(key);

    for (const [key, p] of [...this.pending]) {
      if (p.sentAt !== null && now - p.sentAt > this.timeoutMs) this.resolve(key, fallbackDecision(state, p.q, 'timeout'), null);
    }

    const queued = [...this.pending.values()].filter((p) => p.sentAt === null);
    if (queued.length && this.inFlight < this.maxInFlight) this.send(state, queued, now);
  }

  decide(point: DecisionPoint): Dir | null {
    const d = this.ready.get(point.key);
    if (!d) return null;
    this.ready.delete(point.key);
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

  private send(state: GameState, batch: Pending[], now: number): void {
    for (const p of batch) p.sentAt = now;
    this.inFlight += 1;
    const isCurrent = (p: Pending) => this.pending.get(p.q.point.key) === p;
    this.deps
      .transport(buildRequest(state, batch.map((p) => p.q)))
      .then(
        (res) => {
          this.deps.onEvent({
            type: 'call',
            actors: batch.map((p) => p.q.point.actor),
            latencyMs: res.latencyMs,
            usage: res.usage,
            costUsd: res.costUsd,
            traceId: res.traceId,
          });
          for (const p of batch) {
            if (!isCurrent(p)) {
              this.deps.onEvent({ type: 'stale', actor: p.q.point.actor, key: p.q.point.key });
              continue;
            }
            const decision = parseAnswer(res.answers[questionName(p.q.point)], p.q) ?? fallbackDecision(state, p.q, 'invalid answer');
            this.resolve(p.q.point.key, decision, res.latencyMs);
          }
        },
        (err: unknown) => {
          this.deps.onEvent({ type: 'error', message: err instanceof Error ? err.message : String(err) });
          for (const p of batch) if (isCurrent(p)) this.resolve(p.q.point.key, fallbackDecision(state, p.q, 'error'), null);
        },
      )
      .finally(() => {
        this.inFlight -= 1;
      });
  }

  private resolve(key: string, decision: Decision, latencyMs: number | null): void {
    const p = this.pending.get(key);
    if (!p) return;
    this.pending.delete(key);
    this.ready.set(key, decision);
    this.deps.onEvent({ type: 'decision', decision, latencyMs, fruitOnBoard: p.fruitOnBoard });
  }
}
