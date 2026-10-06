import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import type { Recording } from '../src/replay';
import { recordGame } from './record-game';
import { createGame, step } from '../src/sim';
import { checkSubmission } from '../scripts/submissions';
import { BENCH_VERSION, type SubmissionRules } from '../shared/leaderboard';

// Short games keep the replays quick; the rules are the same apart from the cap.
const RULES: SubmissionRules = { minGames: 3, maxSeconds: 20, maxStep: 0.05 };

// Different step timings make different games, as real-time runs do.
/** The step that ends the opening "ready" pause. */
function readyEnds(rec: Recording): number {
  const s = createGame();
  for (let f = 0; ; f++) {
    step(s, rec.frames[f], { decide: () => null });
    if (s.status === 'playing') return f;
  }
}

const recorded = [1 / 60, 1 / 59, 1 / 61, 1 / 58].map((dt) => recordGame(RULES.maxSeconds, dt));

/** A submission folder as bench --submit writes it, with any part overridden. */
function folder(opts: { manifest?: Record<string, unknown> | null; games?: number; tamper?: (rec: Recording) => void; same?: boolean } = {}): string {
  const dir = join(mkdtempSync(join(tmpdir(), 'jevman-sub-')), 'acme-pac');
  mkdirSync(dir);
  const games = opts.games ?? RULES.minGames;
  for (let i = 1; i <= games; i++) {
    const rec = structuredClone(recorded[opts.same ? 0 : i - 1]);
    if (i === 3) opts.tamper?.(rec);
    writeFileSync(join(dir, `game-${String(i).padStart(2, '0')}.json.gz`), gzipSync(JSON.stringify(rec)));
  }
  const manifest = opts.manifest === null ? null : { name: 'Acme Pac', by: 'acme', url: 'https://acme.example', benchVersion: BENCH_VERSION, games, ...opts.manifest };
  writeFileSync(join(dir, 'submission.json'), JSON.stringify(manifest));
  return dir;
}

describe('checkSubmission', () => {
  it('replays every game and builds a self-reported entry from the replays', () => {
    const checked = checkSubmission(folder(), 'acme-pac', RULES);
    expect(checked).toMatchObject({ entry: { model: 'acme-pac', name: 'Acme Pac', by: 'acme', selfReported: true, games: RULES.minGames } });
    const mean = recorded.slice(0, RULES.minGames).reduce((a, g) => a + g.final.score, 0) / RULES.minGames;
    expect('entry' in checked && checked.entry.meanScore).toBe(Math.round(mean));
  });

  it('refuses the whole submission when one game does not check out', () => {
    const checked = checkSubmission(folder({ tamper: (rec) => (rec.final.score += 500) }), 'acme-pac', RULES);
    expect(checked).toMatchObject({ error: expect.stringMatching(/^game-03\.json\.gz: .*claims score/) });
  });

  it('needs enough games, and the count it claims', () => {
    expect(checkSubmission(folder({ games: RULES.minGames - 1 }), 'acme-pac', RULES)).toMatchObject({ error: expect.stringMatching(/needs at least/) });
    expect(checkSubmission(folder({ manifest: { games: 30 } }), 'acme-pac', RULES)).toMatchObject({ error: expect.stringMatching(/says 30 games/) });
  });

  it('refuses the same game sent more than once, even with its pauses retimed', () => {
    expect(checkSubmission(folder({ same: true }), 'acme-pac', RULES)).toMatchObject({ error: expect.stringMatching(/game-02\.json\.gz is the same game as game-01/) });
    // Retiming the "ready" pause changes the file, not the game: the step that ends it drops its overshoot.
    const retimed = folder({
      same: true,
      tamper: (rec) => {
        rec.frames[10] += 0.0001;
        rec.frames[11] -= 0.0001;
        rec.frames[readyEnds(rec)] = 0.045;
      },
    });
    expect(checkSubmission(retimed, 'acme-pac', RULES)).toMatchObject({ error: expect.stringMatching(/is the same game as/) });
  });

  it('leaves out submissions from an older bench version, but checks any other version as a mistake', () => {
    // Version 1 is the first: there is no older one yet, and 0 never existed.
    if (BENCH_VERSION > 1) expect(checkSubmission(folder({ manifest: { benchVersion: BENCH_VERSION - 1 } }), 'acme-pac', RULES)).toMatchObject({ outdated: true });
    for (const benchVersion of [0, String(BENCH_VERSION), BENCH_VERSION + 1, null]) {
      const checked = checkSubmission(folder({ manifest: { benchVersion } }), 'acme-pac', RULES);
      expect(checked).toMatchObject({ error: expect.stringMatching(/benchVersion must be/) });
      expect(checked).not.toHaveProperty('outdated');
    }
  });

  it('refuses a broken submission.json without crashing', () => {
    expect(checkSubmission(folder({ manifest: null }), 'acme-pac', RULES)).toMatchObject({ error: expect.stringMatching(/must be an object/) });
    expect(checkSubmission(folder({ manifest: { name: 'Acme\u202ePac' } }), 'acme-pac', RULES)).toMatchObject({ error: expect.stringMatching(/printable/) });
  });

  it('refuses a submission posing as a model we benchmark, and checks who and where', () => {
    expect(checkSubmission(folder({ manifest: { name: 'jev 1.13' } }), 'acme-pac', RULES)).toMatchObject({ error: expect.stringMatching(/main leaderboard/) });
    expect(checkSubmission(folder({ manifest: { by: 'not a handle!' } }), 'acme-pac', RULES)).toMatchObject({ error: expect.stringMatching(/GitHub handle/) });
    expect(checkSubmission(folder({ manifest: { url: 'javascript:alert(1)' } }), 'acme-pac', RULES)).toMatchObject({ error: expect.stringMatching(/https/) });
  });
});
