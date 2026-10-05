import { ACTOR_IDS } from './types';
import type { ModelChoice } from './choice';

/** How long a model counts as awake after it last answered (warm-up or game call). */
export const AWAKE_MS = 5 * 60_000;

/**
 * Tracks which models are awake. Opper scales idle models down, and their first call can take many seconds, so a
 * model is warmed up (one tiny call) before it plays.
 */
export class ModelWarming {
  private readonly running = new Map<string, Promise<boolean>>();
  private readonly lastAnswer = new Map<string, number>();

  constructor(private readonly deps: { warmUp: (model: string) => Promise<boolean>; now: () => number }) {}

  isWarm(model: string): boolean {
    const at = this.lastAnswer.get(model);
    return at !== undefined && this.deps.now() - at < AWAKE_MS;
  }

  /** A game call to `model` just came back, so it is awake. */
  touch(model: string): void {
    this.lastAnswer.set(model, this.deps.now());
  }

  /** Resolves true once the model is awake; false if it still didn't answer after `attempts` warm-ups. */
  warm(model: string, attempts = 2): Promise<boolean> {
    if (this.isWarm(model)) return Promise.resolve(true);
    const running = this.running.get(model);
    if (running) return running;
    const done = (async () => {
      for (let i = 0; i < attempts; i++) {
        if (await this.deps.warmUp(model)) {
          this.lastAnswer.set(model, this.deps.now());
          return true;
        }
      }
      return false;
    })().finally(() => this.running.delete(model));
    this.running.set(model, done);
    return done;
  }

  /**
   * Warm every model until all are awake, or some would not wake. `models` is re-read, as the player may pick again
   * meanwhile. Resolves to the models that would not wake (none: ready to play).
   */
  async warmAll(models: () => string[], onWaiting: (cold: string[]) => void): Promise<string[]> {
    for (;;) {
      const cold = models().filter((m) => !this.isWarm(m));
      if (!cold.length) return [];
      onWaiting(cold);
      const failed = (await Promise.all(cold.map(async (m) => ((await this.warm(m)) ? null : m)))).filter((m): m is string => m !== null);
      // Only failures of models still wanted count: the player may have picked another one meanwhile.
      const wanted = new Set(models());
      const stillNeeded = failed.filter((m) => wanted.has(m));
      if (stillNeeded.length) return stillNeeded;
    }
  }
}

/**
 * What plays now: the picked model once it is awake; until then the model that was playing (if still awake), else the
 * fallback (the server default).
 */
export function effectiveChoice(wanted: ModelChoice, current: ModelChoice, isWarm: (m: string) => boolean, fallback: string): ModelChoice {
  return Object.fromEntries(ACTOR_IDS.map((id) => [id, isWarm(wanted[id]) ? wanted[id] : isWarm(current[id]) ? current[id] : fallback])) as ModelChoice;
}
