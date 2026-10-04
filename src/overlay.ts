import { signIn, type Me } from './auth';
import { FRUIT_EMOJI } from './render';
import { deathLabel, type GameSummary } from './stats';

type Row = [label: string, value: string];

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/** The game-over numbers as label/value rows (pure, so it can be tested without a DOM). */
export function summaryRows(s: GameSummary): { game: Row[]; jev: Row[] } {
  const j = s.jev;
  return {
    game: [
      ['Level', String(s.level)],
      ['Time', clock(s.seconds)],
      ['Pellets', String(s.pellets)],
      ['Ghosts eaten', String(s.ghostsEaten)],
      ['Fruit', s.fruit.length ? s.fruit.map((f) => FRUIT_EMOJI[f.kind] ?? f.kind).join(' ') : '–'],
    ],
    jev: [
      ['Calls', String(j.calls)],
      ['Decisions', String(j.decisions)],
      ['Fallbacks', String(j.fallbacks)],
      ['Mean latency', j.meanLatencyMs === null ? '–' : `${j.meanLatencyMs} ms`],
      ['Avg confidence', j.meanConfidence === null ? '–' : `${Math.round(j.meanConfidence * 100)}%`],
      ['Cost', j.costUsd === null ? '–' : `${j.costEstimated ? '≈' : ''}$${j.costUsd.toFixed(4)}`],
      ...(j.errors ? [['Failed calls', String(j.errors)] as Row] : []),
    ],
  };
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, cls?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  if (cls) e.className = cls;
  return e;
}

function table(title: string, rows: Row[]): HTMLElement {
  const box = el('section', undefined, 'stats');
  box.append(el('h3', title));
  const dl = el('dl');
  for (const [k, v] of rows) dl.append(el('dt', k), el('dd', v));
  box.append(dl);
  return box;
}

function show(root: HTMLElement, card: HTMLElement, button: HTMLButtonElement): void {
  const title = card.querySelector('h2');
  if (title) {
    title.id = 'overlay-title';
    root.setAttribute('aria-labelledby', title.id);
  }
  root.replaceChildren(card);
  root.hidden = false;
  button.focus({ preventScroll: true });
}

export function hideOverlay(root: HTMLElement): void {
  root.hidden = true;
  root.replaceChildren();
}

/**
 * Before a live game: nothing runs (and nothing is billed) until the player presses Play. Returns what
 * Space/Enter should do. Without any key (signed out, demo unavailable) it offers sign-in instead.
 */
export function showPlay(root: HTMLElement, me: Me, onPlay: () => void): () => void {
  const card = el('div', undefined, 'card');
  if (me.mode === 'none') {
    card.append(el('h2', 'Sign in to play'));
    card.append(el('p', 'Sign in with Opper to let jev play live; calls bill your own Opper wallet.'));
    const button = el('button', 'Sign in with Opper', 'primary');
    button.addEventListener('click', signIn);
    card.append(button);
    show(root, card, button);
    return signIn;
  }
  card.append(el('h2', 'Ready when you are'));
  card.append(el('p', 'jev drives the ghosts, and Pac-Man too unless you press J to steer him yourself.'));
  card.append(el('p', me.mode === 'player'
    ? 'A game usually costs about $0.02–0.03 from your Opper wallet.'
    : me.devProvider === 'typesafe' ? 'Calls use your TypeSafe key from .env.' : 'Calls use the local key from .env.', 'muted'));
  const play = el('button', undefined, 'primary');
  const icon = el('span', '▶ ');
  icon.setAttribute('aria-hidden', 'true');
  play.append(icon, 'Play');
  play.addEventListener('click', onPlay);
  card.append(play, el('p', 'or press Space / Enter', 'muted small'));
  show(root, card, play);
  return onPlay;
}

export function showGameOver(root: HTMLElement, summary: GameSummary, onPlayAgain: () => void): void {
  const rows = summaryRows(summary);
  const card = el('div', undefined, 'card wide');
  card.append(el('h2', 'Game over'));
  card.append(el('p', `${summary.score} points`, 'score'));
  const grid = el('div', undefined, 'grid');
  grid.append(table('This game', rows.game), table('jev', rows.jev));
  card.append(grid);
  if (summary.deaths.length) {
    const box = el('section', undefined, 'deaths');
    box.append(el('h3', 'How Pac-Man was caught'));
    const list = el('ol');
    for (const d of summary.deaths) list.append(el('li', `${clock(d.seconds)} — ${deathLabel(d)}`));
    box.append(list);
    card.append(box);
  }
  const again = el('button', 'Play again', 'primary');
  again.addEventListener('click', onPlayAgain);
  card.append(again, el('p', 'or press Space / Enter / R', 'muted small'));
  show(root, card, again);
}
