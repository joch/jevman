import { signIn, type Me } from './auth';
import { FRUIT_EMOJI } from './render';
import { deathLabel, type GameSummary } from './stats';
import { modelSelect, type ModelPicking } from './picker';
import { setGhosts } from './choice';
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

/** Who plays each side of a live game: Pac-Man by you or a model, the ghosts by the classic rules or a model. */
export interface Sides {
  pacman: 'you' | 'ai';
  ghosts: 'classic' | 'ai';
}

/** You against the classic ghosts: the leaderboard's game, free, no AI. */
export const isClassic = (s: Sides): boolean => s.pacman === 'you' && s.ghosts === 'classic';

export interface PlayCard {
  /** What Space/Enter does: play. */
  action: () => void;
  /** Show these sides as chosen (e.g. after J was pressed). */
  select: (sides: Sides) => void;
  /** While models wake up: a note on the Play button, which stays disabled; null restores it. */
  busy: (note: string | null) => void;
  /** A message under the Play button (e.g. a model that would not wake), or null to clear it. */
  note: (text: string | null) => void;
}

/** One line on the game the chosen sides make. */
export function gameLine(sides: Sides, pacman: string, ghosts: string): string {
  if (isClassic(sides)) return 'You against the classic ghosts: the game the AIs played on the leaderboard. Free.';
  if (sides.ghosts === 'classic') return `Watch ${pacman} play Pac-Man against the classic ghosts.`;
  if (sides.pacman === 'you') return `You steer Pac-Man (arrows, WASD or swipe) against ${ghosts}'s ghosts.`;
  return pacman === ghosts ? `${pacman} plays both sides: Pac-Man and the ghosts.` : `${pacman} plays Pac-Man, ${ghosts} plays the ghosts.`;
}

/**
 * The card before a live game: who plays each side (and which model), then Play. Signed out, only the classic game
 * can be played (no AI, nothing billed); the AI sides ask to sign in.
 */
export function showPlay(
  root: HTMLElement,
  me: Me,
  opts: { sides: Sides; onSelect: (sides: Sides) => void; onPlay: () => void; models?: ModelPicking; onClose?: () => void },
): PlayCard {
  const card = el('div', undefined, 'card wide');
  if (opts.onClose) {
    // Back to the recorded demo playing behind the card.
    const close = el('button', '×', 'close');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close');
    close.addEventListener('click', opts.onClose);
    card.append(close);
  }
  const signedOut = me.mode === 'none';
  card.append(el('h2', signedOut ? 'Can you beat the AI?' : 'Ready when you are'));
  const play = el('button', undefined, 'primary');
  let sides: Sides = signedOut ? { pacman: 'you', ghosts: 'classic' } : opts.sides;
  const line = el('p', undefined, 'muted');
  const cost = el('p', undefined, 'muted small');
  const rows = el('div', undefined, 'sides');
  const render = () => {
    const m = opts.models;
    const name = (id: string | undefined) => (id ? (m?.options.find((o) => o.id === id)?.label ?? modelName(id)) : 'the AI');
    line.textContent = gameLine(sides, name(m?.choice().pacman), name(m?.choice().blinky));
    cost.textContent = isClassic(sides)
      ? ''
      : me.mode === 'player'
        ? `About $0.01 a game from your Opper wallet per side the AI plays (Clef about $0.02).`
        : me.devProvider === 'typesafe'
          ? 'Calls use your TypeSafe key from .env.'
          : 'Calls use the local key from .env.';
  };
  const change = (next: Sides) => {
    sides = next;
    select(next);
    opts.onSelect(next);
  };
  /** One side: a two-way switch, and the model playing it when the AI does. */
  const side = (label: string, key: 'pacman' | 'ghosts', other: 'you' | 'classic', otherLabel: string) => {
    const row = el('div', undefined, 'side');
    row.append(el('span', label, 'side-name'));
    const seg = el('div', undefined, 'seg');
    seg.setAttribute('role', 'radiogroup');
    seg.setAttribute('aria-label', label);
    const option = (value: string, text: string) => {
      const b = el('button', text);
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.dataset.value = value;
      b.addEventListener('click', () => {
        change({ ...sides, [key]: value } as Sides);
        play.focus({ preventScroll: true }); // so Space/Enter now starts the game
      });
      return b;
    };
    seg.append(option(other, otherLabel), option('ai', 'AI'));
    row.append(seg);
    const m = opts.models;
    if (m) {
      const value = key === 'pacman' ? m.choice().pacman : m.choice().blinky;
      const pickModel = (model: string) => {
        m.onChange(key === 'pacman' ? { ...m.choice(), pacman: model } : setGhosts(m.choice(), model));
        render();
      };
      const sel = modelSelect(m, value, pickModel, key === 'pacman' ? 'Model playing Pac-Man' : 'Model playing the ghosts');
      row.append(sel);
    }
    return row;
  };
  if (!signedOut) {
    rows.append(side('Pac-Man', 'pacman', 'you', 'You'), side('Ghosts', 'ghosts', 'classic', 'Classic'));
    card.append(rows);
  }
  const select = (next: Sides) => {
    sides = next;
    for (const row of rows.querySelectorAll<HTMLElement>('.side')) {
      const key = row.querySelector('.side-name')?.textContent === 'Pac-Man' ? 'pacman' : 'ghosts';
      for (const b of row.querySelectorAll<HTMLButtonElement>('.seg button')) b.setAttribute('aria-checked', String(b.dataset.value === next[key]));
      const sel = row.querySelector<HTMLSelectElement>('select');
      if (sel) sel.hidden = next[key] !== 'ai';
    }
    render();
  };
  card.append(line);
  const icon = el('span', '▶ ');
  icon.setAttribute('aria-hidden', 'true');
  const label = el('span', signedOut ? 'Play free' : 'Play');
  play.append(icon, label);
  play.addEventListener('click', opts.onPlay);
  card.append(play, cost);
  if (signedOut) {
    const more = el('div', undefined, 'signin-more');
    more.append(el('p', 'Want to watch the AI play, or face AI ghosts? Calls bill your own Opper wallet.', 'muted small'));
    const signin = el('button', 'Sign in with Opper', 'signin');
    if (me.loginAvailable) signin.addEventListener('click', signIn);
    else {
      // Login with Opper isn't configured here (its route answers 503): don't offer a broken action.
      signin.disabled = true;
      signin.title = 'Login with Opper is not configured on this server';
    }
    more.append(signin);
    card.append(more);
  }
  select(sides);
  show(root, card, play);
  // aria-disabled, not disabled: the button keeps focus while models wake, and repeat presses are ignored by onPlay.
  const status = el('p', undefined, 'muted small');
  status.setAttribute('aria-live', 'polite');
  const busy = (note: string | null) => {
    play.toggleAttribute('aria-disabled', note !== null);
    play.setAttribute('aria-busy', String(note !== null));
    label.textContent = note ?? (signedOut ? 'Play free' : 'Play');
    status.textContent = note ?? '';
  };
  card.append(status);
  const note = (text: string | null) => {
    status.textContent = text ?? '';
  };
  return { action: opts.onPlay, select, busy, note };
}

/** The extras a game-over card can show: how you did against the AIs, your best, or how the AI did against its average. */
export interface GameOverExtra {
  versus?: string;
  newBest?: boolean;
  best?: number;
  aiNote?: string;
  /** Shares the result (system share sheet, else the clipboard); resolves to what happened. */
  share?: () => Promise<'shared' | 'copied' | 'failed' | 'cancelled'>;
}

export function showGameOver(root: HTMLElement, summary: GameSummary, onPlayAgain: () => void, extra: GameOverExtra = {}): void {
  const rows = summaryRows(summary);
  const card = el('div', undefined, 'card wide');
  card.append(el('h2', 'Game over'));
  card.append(el('p', `${summary.score.toLocaleString('en-US')} points`, 'score'));
  if (extra.newBest) card.append(el('p', '🎉 New personal best!', 'best'));
  else if (extra.best) card.append(el('p', `Your best: ${extra.best.toLocaleString('en-US')}`, 'muted small'));
  if (extra.versus || extra.aiNote) {
    const box = el('section', undefined, 'versus');
    box.append(el('p', extra.versus ?? extra.aiNote));
    const actions = el('div', undefined, 'versus-actions');
    if (extra.share) {
      const share = el('button', 'Share your score', 'signin');
      share.type = 'button';
      share.addEventListener('click', () => {
        void extra.share!().then((r) => {
          if (r === 'cancelled') return; // the share sheet was closed: nothing to report
          share.textContent = r === 'copied' ? 'Copied! Paste it anywhere' : r === 'shared' ? 'Shared!' : 'Could not share';
        });
      });
      actions.append(share);
    }
    const board = el('a', 'Leaderboard →');
    board.href = '/leaderboard';
    actions.append(board);
    box.append(actions);
    card.append(box);
  }
  const grid = el('div', undefined, 'grid');
  grid.append(table('This game', rows.game));
  // A game with no AI (the classic game) has no decisions to show.
  if (summary.jev.calls || summary.jev.decisions) grid.append(table('Decisions', rows.jev));
  else grid.classList.add('single');
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
