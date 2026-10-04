import type { SchedulerEvent } from './scheduler';
import { createGame, step, type Controls, type GameState } from './sim';
import type { Dir } from './types';

type CallEvent = Extract<SchedulerEvent, { type: 'call' }>;
/** A scheduler event as stored in a recording: call events drop traceId, which points at the recorder's own Opper traces. */
export type RecordedEvent = Exclude<SchedulerEvent, CallEvent> | Omit<CallEvent, 'traceId'>;

export interface Recording {
  version: 1;
  recordedAt: string;
  model: string;
  /** Each frame's simulation step in seconds, rounded with roundDt. */
  frames: number[];
  /** Every non-null direction Controls.decide returned: [frame, decision key, direction]. */
  decisions: [number, string, Dir][];
  /** Scheduler events for the panel: [frame, event]. */
  events: [number, RecordedEvent][];
  final: { score: number; lives: number; level: number; frames: number };
}

/** Steps are stored to 0.1 ms; recording and replay both step with the rounded value. */
export const roundDt = (dt: number): number => Math.round(dt * 10_000) / 10_000;

export class Recorder {
  readonly frames: number[] = [];
  readonly decisions: [number, string, Dir][] = [];
  readonly events: [number, RecordedEvent][] = [];

  /** Keeps a scheduler event for the panel, without its trace id. */
  record(frame: number, e: SchedulerEvent): void {
    if (e.type === 'call') {
      const { traceId: _omit, ...rest } = e;
      this.events.push([frame, rest]);
    } else this.events.push([frame, e]);
  }

  wrap(ctl: Controls, frame: () => number): Controls {
    return {
      decide: (point) => {
        const choice = ctl.decide(point);
        if (choice !== null) this.decisions.push([frame(), point.key, choice]);
        return choice;
      },
    };
  }

  finish(state: GameState, model: string): Recording {
    return {
      version: 1,
      recordedAt: new Date().toISOString(),
      model,
      frames: this.frames,
      decisions: this.decisions,
      events: this.events,
      final: { score: state.score, lives: state.lives, level: state.level, frames: this.frames.length },
    };
  }
}

/** Re-runs a recorded game: same steps, same answers, so the same game. */
export class Replay {
  readonly state: GameState = createGame();
  frame = 0;
  /** Per frame+key, the answers decide() returned, in call order (a key can be asked several times per frame). */
  private readonly choices = new Map<string, Dir[]>();
  private readonly eventsByFrame = new Map<number, SchedulerEvent[]>();

  constructor(private readonly rec: Recording) {
    for (const [f, key, dir] of rec.decisions) this.choices.set(`${f}|${key}`, [...(this.choices.get(`${f}|${key}`) ?? []), dir]);
    for (const [f, e] of rec.events) {
      const event: SchedulerEvent = e.type === 'call' ? { ...e, traceId: null } : e;
      this.eventsByFrame.set(f, [...(this.eventsByFrame.get(f) ?? []), event]);
    }
  }

  get done(): boolean {
    return this.frame >= this.rec.frames.length;
  }

  /** Advances one recorded frame and returns the panel events recorded for it; once done, does nothing. */
  stepFrame(): SchedulerEvent[] {
    if (this.done) return [];
    const f = this.frame;
    step(this.state, this.rec.frames[f], { decide: (p) => this.choices.get(`${f}|${p.key}`)?.shift() ?? null });
    this.frame += 1;
    return this.eventsByFrame.get(f) ?? [];
  }
}
