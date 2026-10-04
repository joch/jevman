// Replays recorded games (bench --record) and explains each of Pac-Man's deaths.
// Run: npm run deaths -- recording.json [...]
import { readFileSync } from 'node:fs';
import { criteriaFor } from '../src/brain';
import { greedyChoice, optionFeatures } from '../src/features';
import { createGame, step, type DecisionPoint } from '../src/sim';
import type { Recording } from '../src/replay';
import type { Decision } from '../src/brain';
import { GHOST_IDS, type Dir } from '../src/types';

for (const file of process.argv.slice(2)) {
  const rec = JSON.parse(readFileSync(file, 'utf8')) as Recording;
  const choices = new Map<string, Dir[]>();
  for (const [f, key, dir] of rec.decisions) choices.set(`${f}|${key}`, [...(choices.get(`${f}|${key}`) ?? []), dir]);
  // Pac-Man's answers per key in event order; a key can recur, so each use takes the latest one announced by then.
  const answers = new Map<string, [number, Decision][]>();
  for (const [f, e] of rec.events) if (e.type === 'decision' && e.decision.actor === 'pacman') answers.set(e.decision.key, [...(answers.get(e.decision.key) ?? []), [f, e.decision]]);
  const answerAt = (key: string, f: number) => (answers.get(key) ?? []).filter(([at]) => at <= f).at(-1)?.[1];
  const s = createGame();
  const log: { t: number; point: DecisionPoint; choice: Dir; criteria: Record<string, string>; greedy: Dir; answer?: Decision; ghosts: string }[] = [];
  let t = 0;
  console.log(`\n=== ${file}: score ${rec.final.score}`);
  for (let f = 0; f < rec.frames.length; f++) {
    const was = s.status;
    step(s, rec.frames[f], {
      decide: (p, st) => {
        const choice = choices.get(`${f}|${p.key}`)?.shift() ?? null;
        if (choice && p.actor === 'pacman') {
          const feats = optionFeatures(st, p);
          log.push({
            t, point: p, choice, criteria: criteriaFor(st, p, feats), greedy: greedyChoice(st, p, feats), answer: answerAt(p.key, f),
            ghosts: GHOST_IDS.map((id) => `${id[0]}(${st.ghosts[id].tile.x},${st.ghosts[id].tile.y})${st.ghosts[id].dir[0]}${st.ghosts[id].state === 'normal' ? '' : ':' + st.ghosts[id].state}`).join(' '),
          });
        }
        return choice;
      },
    });
    if (was === 'playing') t += rec.frames[f];
    if (was === 'playing' && s.status === 'dying') {
      const p = s.pacman;
      const g = s.caughtBy ? s.ghosts[s.caughtBy] : null;
      console.log(`\n-- death at ${t.toFixed(1)}s: pacman (${p.tile.x},${p.tile.y}) ${p.dir}, caught by ${s.caughtBy} at (${g?.tile.x},${g?.tile.y}) ${g?.dir}`);
      for (const d of log.slice(-3)) {
        const src = d.answer
          ? `${d.answer.source}${d.answer.reason ? `/${d.answer.reason}` : ''}${d.answer.vetoed ? ` (safety override of ${d.answer.vetoed})` : ''} p=${JSON.stringify(d.answer.probabilities)}`
          : '?';
        console.log(`  ${(t - d.t).toFixed(1)}s before: ${d.point.escape ? 'ESCAPE ' : ''}at (${d.point.tile.x},${d.point.tile.y}) heading ${d.point.heading} -> ${d.choice} [greedy ${d.greedy}] ${src}`);
        console.log(`    ghosts: ${d.ghosts}`);
        for (const [dir, c] of Object.entries(d.criteria)) console.log(`    ${dir === d.choice ? '*' : ' '} ${c}`);
      }
      log.length = 0;
    }
  }
}
