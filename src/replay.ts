import type { SchedulerEvent } from './scheduler';
import { createGame, step, type Controls, type GameState } from './sim';
import type { Dir } from './types';

export interface Recording {
  version: 1;
  recordedAt: string;
  model: string;
  /** Each frame's simulation step in seconds, rounded with roundDt. */
  frames: number[];
  /** Every non-null direction Controls.decide returned: [frame, decision key, direction]. */
  decisions: [number, string, Dir][];
  /** Scheduler events for the panel: [frame, event]. */
  events: [number, SchedulerEvent][];
  final: { score: number; lives: number; level: number; frames: number };
}

/** Steps are stored to 0.1 ms; recording and replay both step with the rounded value. */
export const roundDt = (dt: number): number => Math.round(dt * 10_000) / 10_000;

export class Recorder {
  readonly frames: number[] = [];
  readonly decisions: [number, string, Dir][] = [];
  readonly events: [number, SchedulerEvent][] = [];

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
    for (const [f, e] of rec.events) this.eventsByFrame.set(f, [...(this.eventsByFrame.get(f) ?? []), e]);
  }

  get done(): boolean {
    return this.frame >= this.rec.frames.length;
  }

  /** Advances one recorded frame and returns the panel events recorded for it. */
  stepFrame(): SchedulerEvent[] {
    const f = this.frame;
    step(this.state, this.rec.frames[f], { decide: (p) => this.choices.get(`${f}|${p.key}`)?.shift() ?? null });
    this.frame += 1;
    return this.eventsByFrame.get(f) ?? [];
  }
}
