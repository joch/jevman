import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { Recorder, type Recording } from '../src/replay';
import { createGame, step } from '../src/sim';
import { scriptedControls } from '../scripts/game';
import { checkSubmission } from '../scripts/submissions';
import { BENCH_VERSION, type SubmissionRules } from '../shared/leaderboard';

// Short games keep the replays quick; the rules are the same apart from the cap.
const RULES: SubmissionRules = { minGames: 3, maxSeconds: 20, maxStep: 0.05 };

function recordGame(): Recording {
  const state = createGame();
  const recorder = new Recorder();
  let frame = 0;
  const ctl = recorder.wrap(scriptedControls(), () => frame);
  let survived = 0;
  while (state.status !== 'gameover' && survived < RULES.maxSeconds) {
    recorder.frames.push(1 / 60);
    step(state, 1 / 60, ctl);
    if (state.status === 'playing') survived += 1 / 60;
    frame += 1;
  }
  return recorder.finish(state, 'scripted');
}
const game = recordGame();

/** A submission folder as bench --submit writes it, with any part overridden. */
function folder(opts: { manifest?: Record<string, unknown>; games?: number; tamper?: (rec: Recording) => void } = {}): string {
  const dir = join(mkdtempSync(join(tmpdir(), 'jevman-sub-')), 'acme-pac');
  mkdirSync(dir);
  const games = opts.games ?? RULES.minGames;
  for (let i = 1; i <= games; i++) {
    const rec = structuredClone(game);
    if (i === 3) opts.tamper?.(rec);
    writeFileSync(join(dir, `game-${String(i).padStart(2, '0')}.json.gz`), gzipSync(JSON.stringify(rec)));
  }
  const manifest = { name: 'Acme Pac', by: 'acme', url: 'https://acme.example', benchVersion: BENCH_VERSION, games, ...opts.manifest };
  writeFileSync(join(dir, 'submission.json'), JSON.stringify(manifest));
  return dir;
}

describe('checkSubmission', () => {
  it('replays every game and builds a self-reported entry from the replays', () => {
    const checked = checkSubmission(folder(), 'acme-pac', RULES);
    expect(checked).toMatchObject({ entry: { model: 'acme-pac', name: 'Acme Pac', by: 'acme', selfReported: true, games: RULES.minGames, meanScore: game.final.score } });
  });

  it('refuses the whole submission when one game does not check out', () => {
    const checked = checkSubmission(folder({ tamper: (rec) => (rec.final.score += 500) }), 'acme-pac', RULES);
    expect(checked).toMatchObject({ error: expect.stringMatching(/^game-03\.json\.gz: .*claims score/) });
  });

  it('needs enough games, and the count it claims', () => {
    expect(checkSubmission(folder({ games: RULES.minGames - 1 }), 'acme-pac', RULES)).toMatchObject({ error: expect.stringMatching(/needs at least/) });
    expect(checkSubmission(folder({ manifest: { games: 30 } }), 'acme-pac', RULES)).toMatchObject({ error: expect.stringMatching(/says 30 games/) });
  });

  it('leaves out submissions from another bench version without failing', () => {
    expect(checkSubmission(folder({ manifest: { benchVersion: BENCH_VERSION - 1 } }), 'acme-pac', RULES)).toMatchObject({ outdated: true });
  });

  it('refuses a submission posing as a model we benchmark, and checks who and where', () => {
    expect(checkSubmission(folder({ manifest: { name: 'jev 1.13' } }), 'acme-pac', RULES)).toMatchObject({ error: expect.stringMatching(/main leaderboard/) });
    expect(checkSubmission(folder({ manifest: { by: 'not a handle!' } }), 'acme-pac', RULES)).toMatchObject({ error: expect.stringMatching(/GitHub handle/) });
    expect(checkSubmission(folder({ manifest: { url: 'javascript:alert(1)' } }), 'acme-pac', RULES)).toMatchObject({ error: expect.stringMatching(/https/) });
  });
});
