// Checks every submission in submissions/ and writes the self-reported leaderboard.
// Run: npm run submissions [-- --out public/community.json]
// Each submissions/<id>/ holds submission.json and game-NN.json.gz recordings written by bench --submit. Every game is
// replayed; a submission on the current bench version that breaks a rule or does not replay fails the run (and CI).
// Submissions recorded on an older bench version are left out with a note: their games were a different benchmark.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { gunzipSync } from 'node:zlib';
import type { Recording } from '../src/replay';
import { DECISION_MODELS } from '../shared/models';
import { BENCH_VERSION, rank, SUBMISSION_RULES, summarize, type Community, type CommunityEntry, type GameResult, type SubmissionRules } from '../shared/leaderboard';
import { verifyGame } from './verify';

interface Manifest {
  name: string;
  by: string;
  url?: string;
  benchVersion: number;
  games: number;
}

/** A submission's entry, or why it was refused (`outdated` ones are left out without failing). */
export function checkSubmission(dir: string, id: string, rules: SubmissionRules = SUBMISSION_RULES): { entry: CommunityEntry } | { error: string; outdated?: boolean } {
  const manifestPath = join(dir, 'submission.json');
  if (!existsSync(manifestPath)) return { error: 'no submission.json' };
  let manifest: Manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
  } catch (err) {
    return { error: `submission.json: ${(err as Error).message}` };
  }
  if (typeof manifest.name !== 'string' || !manifest.name.trim() || manifest.name.length > 40) return { error: 'name must be 1 to 40 characters' };
  if (typeof manifest.by !== 'string' || !/^[A-Za-z0-9-]{1,39}$/.test(manifest.by)) return { error: 'by must be a GitHub handle' };
  if (manifest.url !== undefined && (typeof manifest.url !== 'string' || !/^https:\/\/\S+$/.test(manifest.url))) return { error: 'url must start with https://' };
  // A submitted model must not pass for one we benchmark ourselves.
  if (DECISION_MODELS.some((m) => m.id === id || m.name.toLowerCase() === manifest.name.trim().toLowerCase())) return { error: `${manifest.name} is on the main leaderboard already` };
  if (manifest.benchVersion !== BENCH_VERSION) return { error: `recorded on bench version ${manifest.benchVersion}, the current one is ${BENCH_VERSION}: re-run it`, outdated: true };

  const files = readdirSync(dir).filter((f) => /^game-\d+\.json\.gz$/.test(f)).sort();
  if (files.length < rules.minGames) return { error: `${files.length} games; a submission needs at least ${rules.minGames}` };
  if (files.length !== manifest.games) return { error: `submission.json says ${manifest.games} games, the folder has ${files.length}` };
  const results: GameResult[] = [];
  for (const file of files) {
    let rec: Recording;
    try {
      rec = JSON.parse(gunzipSync(readFileSync(join(dir, file))).toString('utf8')) as Recording;
    } catch (err) {
      return { error: `${file}: ${(err as Error).message}` };
    }
    const verdict = verifyGame(rec, rules);
    if (!verdict.ok) return { error: `${file}: ${verdict.error}` };
    results.push(verdict.result);
  }
  const entry: CommunityEntry = {
    ...summarize(id, results, manifest.name.trim()),
    by: manifest.by,
    ...(manifest.url ? { url: manifest.url } : {}),
    selfReported: true,
  };
  return { entry };
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const { values } = parseArgs({ options: { dir: { type: 'string', default: 'submissions' }, out: { type: 'string', default: 'public/community.json' } } });
  const root = values.dir!;
  const ids = existsSync(root) ? readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort() : [];
  const entries: CommunityEntry[] = [];
  let failed = false;
  for (const id of ids) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
      console.error(`${id}: the folder name is the model id: lowercase letters, digits and dashes`);
      failed = true;
      continue;
    }
    const checked = checkSubmission(join(root, id), id);
    if ('entry' in checked) {
      const e = checked.entry;
      console.log(`${id}: ok, ${e.games} games, mean score ${e.meanScore} ± ${Math.round(2 * (e.scoreStdError ?? 0))}`);
      entries.push(e);
    } else if (checked.outdated) {
      console.warn(`${id}: left out, ${checked.error}`);
    } else {
      console.error(`${id}: REFUSED, ${checked.error}`);
      failed = true;
    }
  }
  const community: Community = { generatedAt: new Date().toISOString(), benchVersion: BENCH_VERSION, entries: rank(entries) as CommunityEntry[] };
  mkdirSync(dirname(values.out!), { recursive: true });
  writeFileSync(values.out!, `${JSON.stringify(community, null, 2)}\n`);
  console.log(`wrote ${entries.length} self-reported ${entries.length === 1 ? 'entry' : 'entries'} to ${values.out}`);
  if (failed) process.exit(1);
}
