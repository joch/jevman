import './style.css';
import type { Community, Leaderboard } from '../shared/leaderboard';
import { communityRows, leaderboardRows, topScore, verdict, type LeaderboardRow } from './leaderboard-view';

const $ = (id: string) => document.getElementById(id)!;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, cls?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  if (cls) e.className = cls;
  return e;
}

function rowElement(r: LeaderboardRow): HTMLLIElement {
  const li = el('li', undefined, 'lb-entry');
  const head = el('div', undefined, 'lb-head');
  head.append(el('span', String(r.rank), 'lb-rank'));
  const who = el('div', undefined, 'lb-who');
  who.append(el('strong', r.name), el('span', r.maker, 'lb-maker'));
  head.append(who);
  const badges = el('div', undefined, 'lb-badges');
  for (const b of r.badges) badges.append(el('span', b, b === 'Self-reported' ? 'lb-badge lb-self' : 'lb-badge'));
  head.append(badges);
  const bar = el('div', undefined, 'lb-bar');
  const fill = el('span', undefined, 'lb-fill');
  fill.style.width = `${r.barPercent}%`;
  bar.append(fill, el('span', r.scoreLabel, 'lb-score'));
  // One plain line (and the watch link) under the bar; the rest of the numbers fold away.
  const line = el('div', undefined, 'lb-line');
  line.append(el('span', r.summary, 'lb-summary'));
  if (r.link) {
    const link = el('a', r.link.label, 'lb-watch');
    link.href = r.link.href;
    // A submitter's page is somewhere else entirely.
    if (!r.link.href.startsWith('/')) Object.assign(link, { target: '_blank', rel: 'noopener noreferrer nofollow ugc' });
    line.append(link);
  }
  const more = el('details', undefined, 'lb-more');
  more.append(el('summary', 'More stats'));
  const stats = el('dl', undefined, 'lb-stats');
  for (const [k, v] of r.stats) {
    const stat = el('div', undefined, 'lb-stat');
    stat.append(el('dt', k), el('dd', v));
    stats.append(stat);
  }
  more.append(stats);
  li.append(head, bar, line, more);
  return li;
}

const CONTRIBUTING = 'https://github.com/joch/jevman/blob/main/CONTRIBUTING.md#benchmark-your-own-model';

function renderCommunity(community: Community, top: number): void {
  const how = el('a', 'benchmark your own model and send a pull request');
  how.href = CONTRIBUTING;
  const note = $('community-note');
  if (!community.entries.length) {
    note.replaceChildren('Nobody has submitted a model yet. You can be first: ', how, '.');
    return;
  }
  note.replaceChildren(
    'Benchmarked by their makers on the same games and rules, then submitted by pull request. Every game was replayed to check its score, but we did not run these models ourselves: that the moves are the model\'s own, how often it fell back, its latency and its cost are as reported. To add yours, ',
    how,
    '.',
  );
  $('community-list').replaceChildren(...communityRows(community.entries, top).map(rowElement));
}

function render(board: Leaderboard, community: Community): void {
  const { gamesPerModel, maxSeconds } = board.settings;
  const date = new Date(board.generatedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  $('verdict').textContent = verdict(board);
  $('lede').textContent = `${board.entries.length} AI models each played ${gamesPerModel} games of Pac-Man against the classic arcade ghosts. Ranked by average score.`;
  $('list').replaceChildren(...leaderboardRows(board, topScore(board.entries, community.entries)).map(rowElement));
  renderCommunity(community, topScore(board.entries, community.entries));
  // Results written before models could be skipped have no `skipped` list.
  const skipped = (board.skipped ?? []).map((s) => `${s.model} could not play: ${s.reason}`);
  $('method').replaceChildren(
    ...[
      `Each model played ${gamesPerModel} games. A game lasts until Pac-Man loses his three lives, or ${Math.round(maxSeconds / 60)} minutes.`,
      'The AI plays Pac-Man. The ghosts follow the classic arcade rules, the same for every model.',
      'Every move is the AI\'s own. It plays in real time: if it takes more than 2 seconds to decide, a simple backup rule moves for it.',
      'Scores vary from game to game, so the ± shows the margin of error. Models within it of each other are tied.',
      ...skipped,
      `Last run ${date}. The code is open source: run it yourself, or add your own model.`,
    ].map((t) => el('li', t)),
  );
}

const NO_SUBMISSIONS: Community = { generatedAt: '', benchVersion: 0, entries: [] };

Promise.all([
  fetch('/leaderboard.json').then((r) => (r.ok ? (r.json() as Promise<Leaderboard>) : Promise.reject(new Error(String(r.status))))),
  // Missing (a dev server without npm run submissions) or broken, the self-reported list is just empty.
  fetch('/community.json')
    .then((r) => (r.ok ? (r.json() as Promise<Community>) : NO_SUBMISSIONS))
    .catch(() => NO_SUBMISSIONS),
])
  .then(([board, community]) => render(board, community))
  .catch(() => {
    $('lede').textContent = 'The results could not be loaded. Try again in a moment.';
  });
