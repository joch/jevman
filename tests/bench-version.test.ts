import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildRequest } from '../src/brain';
import { optionFeatures } from '../src/features';
import { createGame, nextDecisionPoint, step } from '../src/sim';
import { scriptedControls } from '../scripts/game';
import { BENCH_VERSION } from '../shared/leaderboard';
import { ACTOR_IDS } from '../src/types';

/** What a benchmark result depends on: the questions the models get, and how the game plays out. */
function fingerprint(): string {
  const hash = createHash('sha256');
  const s = createGame();
  const ctl = scriptedControls();
  for (let f = 0; f < 60 * 120 && s.status !== 'gameover'; f++) {
    // The questions at a few points of a scripted game, and where everyone is.
    if (f % 600 === 0) {
      const batch = ACTOR_IDS.map((id) => nextDecisionPoint(s, id))
        .filter((p) => p !== null)
        .map((point) => ({ point, features: optionFeatures(s, point) }));
      hash.update(JSON.stringify(buildRequest(s, batch)));
    }
    step(s, 1 / 60, ctl);
  }
  hash.update(JSON.stringify({ score: s.score, lives: s.lives, level: s.level, status: s.status }));
  return hash.digest('hex').slice(0, 16);
}

describe('BENCH_VERSION', () => {
  it('changes whenever the game or the question the models get changes', () => {
    // If this fails, results and submissions recorded before your change are not comparable with new ones: bump
    // BENCH_VERSION in shared/leaderboard.ts, update both values here, and re-run the leaderboard.
    expect({ version: BENCH_VERSION, fingerprint: fingerprint() }).toEqual({ version: 1, fingerprint: 'b279e628b3977994' });
  });
});
