import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildRequest, fallbackDecision } from '../src/brain';
import { optionFeatures } from '../src/features';
import { createGame, decisionPoints, step } from '../src/sim';
import { scriptedControls } from '../scripts/game';
import { BENCH_VERSION } from '../shared/leaderboard';
import { ACTOR_IDS } from '../src/types';

const kinds = { escape: false, hunt: false };

/** What a benchmark result depends on: the questions the models get, and how the game plays out. */
function fingerprint(): string {
  const hash = createHash('sha256');
  const s = createGame();
  const ctl = scriptedControls();
  const seen = new Set<string>();
  for (let f = 0; f < 60 * 300 && s.status !== 'gameover'; f++) {
    // Every question of a whole scripted game (junctions, escapes, hunting while ghosts are frightened), each the
    // first time it comes up, and the fallback rule's answer to it.
    const batch = ACTOR_IDS.flatMap((id) => decisionPoints(s, id))
      .filter((p) => !seen.has(p.key))
      .map((point) => ({ point, features: optionFeatures(s, point) }));
    if (batch.length) {
      for (const q of batch) seen.add(q.point.key);
      hash.update(JSON.stringify(buildRequest(s, batch)));
      hash.update(JSON.stringify(batch.map((q) => fallbackDecision(s, q, 'timeout').choice)));
    }
    step(s, 1 / 60, ctl);
  }
  kinds.escape = [...seen].some((k) => k.startsWith('pacman~'));
  kinds.hunt = [...seen].some((k) => k.startsWith('pacman@') && k.endsWith(':hunt'));
  hash.update(JSON.stringify({ score: s.score, lives: s.lives, level: s.level, status: s.status }));
  return hash.digest('hex').slice(0, 16);
}

describe('BENCH_VERSION', () => {
  it('changes whenever the game or the question the models get changes', () => {
    // If this fails, results and submissions recorded before your change are not comparable with new ones: bump
    // BENCH_VERSION in shared/leaderboard.ts, update both values here, and re-run the leaderboard.
    expect({ version: BENCH_VERSION, fingerprint: fingerprint() }).toEqual({ version: 1, fingerprint: 'b1011b6310fdb460' });
    // The game it fingerprints asks every kind of question.
    expect(kinds).toEqual({ escape: true, hunt: true });
  });
});
