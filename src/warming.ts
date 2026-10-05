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

  /**
   * Resolves once the model is awake, or once its warm-up has failed: a model that can't wake still gets to play, so
   * its fallbacks show the problem instead of the game waiting forever. One warm-up at a time per model.
   */
  warm(model: string): Promise<boolean> {
    if (this.isWarm(model)) return Promise.resolve(true);
    const running = this.running.get(model);
    if (running) return running;
    const done = this.deps.warmUp(model).then((ok) => {
      this.running.delete(model);
      this.lastAnswer.set(model, this.deps.now());
      return ok;
    });
    this.running.set(model, done);
    return done;
  }

  /** Warm every model until all are awake (or failed); `models` is re-read, as the player may pick again meanwhile. */
  async warmAll(models: () => string[], onWaiting: (cold: string[]) => void): Promise<void> {
    for (;;) {
      const cold = models().filter((m) => !this.isWarm(m));
      if (!cold.length) return;
      onWaiting(cold);
      await Promise.all(cold.map((m) => this.warm(m)));
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
