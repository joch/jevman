import { Replay, type Recording } from './replay';
import type { SchedulerEvent } from './scheduler';
import type { GameState } from './sim';

/** Seconds of demo time the finished game stays on screen before the demo starts over. */
export const DEMO_LOOP_PAUSE_S = 3;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The recorded demo, or null if it is missing, malformed, unreachable or slower than `timeoutMs`. */
export async function loadRecording(url: string, timeoutMs = 3000): Promise<Recording | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const rec: unknown = await res.json();
    if (!isObject(rec) || rec.version !== 1 || !isObject(rec.final)) return null;
    if (!Array.isArray(rec.frames) || !Array.isArray(rec.decisions) || !Array.isArray(rec.events)) return null;
    return rec as unknown as Recording;
  } catch {
    return null;
  }
}

/**
 * Plays a recording in real time: `advance` takes the seconds that passed and steps every recorded frame
 * they cover. Once the game ends it waits DEMO_LOOP_PAUSE_S of advanced time (so a paused caller pauses
 * the wait too), then starts over and calls `onLoop`, e.g. to reset the decision panel.
 */
export class DemoPlayer {
  /** How many times the demo has started over. */
  loops = 0;
  private replay: Replay;
  private pending = 0;
  private endedFor = 0;

  constructor(
    private readonly rec: Recording,
    private readonly opts: { onLoop?: () => void } = {},
  ) {
    this.replay = new Replay(rec);
  }

  get state(): GameState {
    return this.replay.state;
  }

  get frame(): number {
    return this.replay.frame;
  }

  get done(): boolean {
    return this.replay.done;
  }

  /** Advances by `dtSec` of demo time and returns the panel events of the frames it stepped. */
  advance(dtSec: number): SchedulerEvent[] {
    if (this.replay.done) {
      this.endedFor += dtSec;
      if (this.endedFor >= DEMO_LOOP_PAUSE_S) {
        this.replay = new Replay(this.rec);
        this.pending = 0;
        this.endedFor = 0;
        this.loops += 1;
        this.opts.onLoop?.();
      }
      return [];
    }
    this.pending += dtSec;
    const events: SchedulerEvent[] = [];
    while (!this.replay.done && this.pending >= this.rec.frames[this.replay.frame]) {
      this.pending -= this.rec.frames[this.replay.frame];
      events.push(...this.replay.stepFrame());
    }
    return events;
  }
}
