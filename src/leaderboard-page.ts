import './style.css';
import type { Leaderboard } from '../shared/leaderboard';
import { leaderboardRows } from './leaderboard-view';
import { tooCloseToCall } from '../shared/leaderboard';

const $ = (id: string) => document.getElementById(id)!;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, cls?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  if (cls) e.className = cls;
  return e;
}

function render(board: Leaderboard): void {
  const { gamesPerModel, maxSeconds } = board.settings;
  const date = new Date(board.generatedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  const [first, second] = board.entries;
  const dead = first && second && tooCloseToCall(first, second);
  $('lede').textContent =
    `${board.entries.length} decision models each played ${gamesPerModel} games of Pac-Man against the classic arcade ghosts, in real time, with no help from the game. Ranked by average score.` +
    (dead ? ` ${first.name} and ${second.name} are too close to call: their scores are within the margin of error.` : '');
  $('list').replaceChildren(
    ...leaderboardRows(board).map((r) => {
      const li = el('li', undefined, 'lb-entry');
      const head = el('div', undefined, 'lb-head');
      head.append(el('span', String(r.rank), 'lb-rank'));
      const who = el('div', undefined, 'lb-who');
      who.append(el('strong', r.name), el('span', r.maker, 'lb-maker'));
      head.append(who);
      const badges = el('div', undefined, 'lb-badges');
      for (const b of r.badges) badges.append(el('span', b, 'lb-badge'));
      head.append(badges);
      const bar = el('div', undefined, 'lb-bar');
      const fill = el('span', undefined, 'lb-fill');
      fill.style.width = `${r.barPercent}%`;
      bar.append(fill, el('span', r.scoreLabel, 'lb-score'));
      const stats = el('dl', undefined, 'lb-stats');
      for (const [k, v] of r.stats) {
        const stat = el('div', undefined, 'lb-stat');
        stat.append(el('dt', k), el('dd', v));
        stats.append(stat);
      }
      const watch = el('a', `Watch ${r.name} play →`, 'lb-watch');
      watch.href = r.playUrl;
      li.append(head, bar, stats, watch);
      return li;
    }),
  );
  // Results written before models could be skipped have no `skipped` list.
  const skipped = (board.skipped ?? []).map((s) => `${s.model} could not play: ${s.reason}`);
  $('method').replaceChildren(
    ...[
      `${gamesPerModel} games per model, each ending at game over or after ${maxSeconds} seconds of play. Scores vary a lot from game to game; the ± is the margin of error on the average (two standard errors).`,
      'Pac-Man is played by the model; the four ghosts follow the classic scripted rules, the same for every model.',
      'Real time: a model that answers slowly reaches junctions late. If it takes over 2 seconds, a simple rule decides that move (counted as a fallback).',
      "The game's safety check, which in normal play overrides moves that walk into a ghost, is off: this measures the model alone.",
      'Every model gets the same question at each junction: the facts about each route (pellets, ghosts, traps, fruit) and a choice of direction.',
      ...skipped,
      `Last run ${date}. Run it yourself with npm run leaderboard.`,
    ].map((t) => el('li', t)),
  );
}

fetch('/leaderboard.json')
  .then((r) => (r.ok ? (r.json() as Promise<Leaderboard>) : Promise.reject(new Error(String(r.status)))))
  .then(render)
  .catch(() => {
    $('lede').textContent = 'The results could not be loaded. Try again in a moment.';
  });
