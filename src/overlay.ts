import { signIn, type Me } from './auth';
import { FRUIT_EMOJI } from './render';
import { deathLabel, type GameSummary } from './stats';
import { renderModelPick, type ModelPicking } from './picker';
import { modelName } from '../shared/models';

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
      ...(j.models.length ? [['Models', j.models.map(modelName).join(', ')] as Row] : []),
      ['Fallbacks', String(j.fallbacks)],
      ['Safety overrides', String(j.overrides)],
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
export type PlayMode = 'jev' | 'keyboard';

export interface PlayCard {
  /** What Space/Enter does: play, or sign in. */
  action: () => void;
  /** Show `mode` as chosen (e.g. after J was pressed). */
  select: (mode: PlayMode) => void;
  /** While models wake up: a note on the Play button, which stays disabled; null restores it. */
  busy: (note: string | null) => void;
  /** A message under the Play button (e.g. a model that would not wake), or null to clear it. */
  note: (text: string | null) => void;
}

/**
 * The card before the first game. Signed in (or with a local key) the player picks a mode, watching jev play Pac-Man
 * by default, and `onSelect` reports each pick so the game can show it; `onPlay` starts the game.
 */
export function showPlay(
  root: HTMLElement,
  me: Me,
  opts: { mode: PlayMode; onSelect: (mode: PlayMode) => void; onPlay: () => void; models?: ModelPicking; onClose?: () => void },
): PlayCard {
  const card = el('div', undefined, 'card');
  if (opts.onClose) {
    // Back to the recorded demo playing behind the card.
    const close = el('button', '×', 'close');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close');
    close.addEventListener('click', opts.onClose);
    card.append(close);
  }
  if (me.mode === 'none') {
    card.append(el('h2', 'Sign in to play'));
    const button = el('button', 'Sign in with Opper', 'primary');
    if (me.loginAvailable) {
      card.append(el('p', 'Sign in with Opper to let the AI play live; calls bill your own Opper wallet.'));
      button.addEventListener('click', signIn);
    } else {
      // Login with Opper isn't configured here (its route answers 503): don't offer a broken action.
      card.append(el('p', 'This server has no API key and Login with Opper is not configured. Clone the repo and add your own key to play.'));
      button.disabled = true;
    }
    card.append(button);
    show(root, card, button);
    return { action: me.loginAvailable ? signIn : () => {}, select: () => {}, busy: () => {}, note: () => {} };
  }
  card.classList.add('wide');
  card.append(el('h2', 'Ready when you are'));
  card.append(el('p', 'A decision model plays one side at a time, so every choice in the decision panel is its own.'));
  const modes = el('div', undefined, 'modes');
  modes.setAttribute('role', 'radiogroup');
  modes.setAttribute('aria-label', 'Mode');
  const choices: [PlayMode, string, string, string][] = [
    ['jev', 'Watch AI play', 'default', 'A decision model steers Pac-Man; the ghosts follow the classic arcade rules.'],
    ['keyboard', 'Play against AI', 'you steer', 'You steer Pac-Man (arrows, WASD or swipe) and decision models steer the four ghosts.'],
  ];
  const play = el('button', undefined, 'primary');
  const buttons = new Map<PlayMode, HTMLButtonElement>();
  const pick = el('div', undefined, 'model-pick');
  const select = (mode: PlayMode) => {
    for (const [m, b] of buttons) b.setAttribute('aria-checked', String(m === mode));
    if (opts.models) renderModelPick(pick, mode === 'jev', opts.models);
  };
  for (const [mode, title, hint, text] of choices) {
    const b = el('button', undefined, 'mode');
    b.type = 'button';
    b.setAttribute('role', 'radio');
    const head = el('span', title, 'title');
    head.append(el('span', hint, 'hint'));
    b.append(head, el('span', text, 'text'));
    b.addEventListener('click', () => {
      select(mode);
      opts.onSelect(mode);
      play.focus({ preventScroll: true }); // so Space/Enter now starts the game
    });
    buttons.set(mode, b);
    modes.append(b);
  }
  select(opts.mode);
  card.append(modes);
  if (opts.models) card.append(pick);
  card.append(el('p', 'Switch sides any time with J or the Pac-Man button, and models on the panel cards.', 'muted small'));
  card.append(el('p', me.mode === 'player'
    ? 'A game usually costs about $0.01 from your Opper wallet (Clef about $0.02), a little more for the ghosts.'
    : me.devProvider === 'typesafe' ? 'Calls use your TypeSafe key from .env.' : 'Calls use the local key from .env.', 'muted'));
  const icon = el('span', '▶ ');
  icon.setAttribute('aria-hidden', 'true');
  const label = el('span', 'Play');
  play.append(icon, label);
  play.addEventListener('click', opts.onPlay);
  card.append(play, el('p', 'or press Space / Enter', 'muted small'));
  show(root, card, play);
  // aria-disabled, not disabled: the button keeps focus while models wake, and repeat presses are ignored by onPlay.
  const status = el('p', undefined, 'muted small');
  status.setAttribute('aria-live', 'polite');
  const busy = (note: string | null) => {
    play.toggleAttribute('aria-disabled', note !== null);
    play.setAttribute('aria-busy', String(note !== null));
    label.textContent = note ?? 'Play';
    status.textContent = note ?? '';
  };
  card.append(status);
  const note = (text: string | null) => {
    status.textContent = text ?? '';
  };
  return { action: opts.onPlay, select, busy, note };
}

export function showGameOver(root: HTMLElement, summary: GameSummary, onPlayAgain: () => void): void {
  const rows = summaryRows(summary);
  const card = el('div', undefined, 'card wide');
  card.append(el('h2', 'Game over'));
  card.append(el('p', `${summary.score} points`, 'score'));
  const grid = el('div', undefined, 'grid');
  grid.append(table('This game', rows.game), table('Decisions', rows.jev));
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
