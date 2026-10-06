import { signIn, type Me } from './auth';
import { FRUIT_EMOJI } from './render';
import { deathLabel, type GameSummary } from './stats';
import { modelSelect, type ModelPicking } from './picker';
import { setGhosts } from './choice';
import { GHOST_IDS } from './types';
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

/** The four games, as cards in the Play dialog: who plays each side, and what that game is. */
export const GAMES: { sides: Sides; title: string; hint: string; text: string }[] = [
  { sides: { pacman: 'ai', ghosts: 'classic' }, title: 'Watch the AI play', hint: 'default', text: 'A model steers Pac-Man; the ghosts follow the classic arcade rules.' },
  { sides: { pacman: 'you', ghosts: 'ai' }, title: 'Play against the AI', hint: 'you steer', text: 'You steer Pac-Man (arrows, WASD or swipe); models play the four ghosts.' },
  { sides: { pacman: 'you', ghosts: 'classic' }, title: 'Beat the AI', hint: 'free', text: 'You against the classic ghosts, the game the AIs played on the leaderboard. See which AIs you beat.' },
  { sides: { pacman: 'ai', ghosts: 'ai' }, title: 'AI vs AI', hint: 'new', text: 'Models play Pac-Man and the ghosts: the same one, or two rivals. Who wins?' },
];

const sameSides = (a: Sides, b: Sides) => a.pacman === b.pacman && a.ghosts === b.ghosts;

/**
 * The card before a live game: pick one of the four games, and the models for the sides the AI plays, then Play.
 * Signed out, only the classic game can be played (no AI, nothing billed); the AI games ask to sign in.
 */
export function showPlay(
  root: HTMLElement,
  me: Me,
  opts: { sides: Sides; onSelect: (sides: Sides) => void; onPlay: () => void; models?: ModelPicking; onClose?: () => void },
): PlayCard {
  const card = el('div', undefined, 'card wide play');
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
  const games = el('div', undefined, 'modes');
  const picks = el('div', undefined, 'model-pick');
  const cards = new Map<HTMLButtonElement, Sides>();
  const rows: Record<'pacman' | 'ghosts', HTMLElement | null> = { pacman: null, ghosts: null };
  /** On a phone the cards show only their names; this line describes the chosen game. */
  const described = el('p', undefined, 'muted mode-text');
  const select = (next: Sides) => {
    for (const [b, sides] of cards) b.setAttribute('aria-checked', String(sameSides(sides, next)));
    // A side the AI doesn't play keeps its row's room, so the card doesn't change size.
    // A side the AI doesn't play says who does, in the dropdown's place.
    for (const key of ['pacman', 'ghosts'] as const) {
      const r = rows[key];
      if (!r) continue;
      r.querySelector('select')!.hidden = next[key] !== 'ai';
      r.querySelector<HTMLElement>('.fixed')!.hidden = next[key] === 'ai';
    }
    described.textContent = GAMES.find((g) => sameSides(g.sides, next))?.text ?? '';
  };
  if (signedOut) {
    card.append(el('p', 'Play Pac-Man against the classic ghosts, free and without signing in, and see which of the AIs on the leaderboard you beat.'));
  } else {
    games.setAttribute('role', 'radiogroup');
    games.setAttribute('aria-label', 'Game');
    for (const g of GAMES) {
      const b = el('button', undefined, 'mode');
      b.type = 'button';
      b.setAttribute('role', 'radio');
      const head = el('span', g.title, 'title');
      head.append(el('span', g.hint, 'hint'));
      b.append(head, el('span', g.text, 'text'));
      b.addEventListener('click', () => {
        select(g.sides);
        opts.onSelect(g.sides);
        play.focus({ preventScroll: true }); // so Space/Enter now starts the game
      });
      cards.set(b, g.sides);
      games.append(b);
    }
    card.append(games, described);
    const m = opts.models;
    if (m) {
      const row = (label: string, control: HTMLElement, otherwise: string) => {
        const r = el('label', undefined, 'model-row');
        r.append(el('span', label), control, el('span', otherwise, 'fixed'));
        return r;
      };
      rows.pacman = row('Pac-Man is played by', modelSelect(m, m.choice().pacman, (model) => m.onChange({ ...m.choice(), pacman: model }), 'Model playing Pac-Man'), 'you');
      const ghostSelect = modelSelect(m, m.choice().blinky, (model) => m.onChange(setGhosts(m.choice(), model)), 'Model playing the ghosts');
      // Ghosts given different models on the panel cards: say so, rather than show Blinky's as everyone's.
      if (!GHOST_IDS.every((id) => m.choice()[id] === m.choice().blinky)) {
        const mixed = new Option('Per ghost (set on the cards)', '', true, true);
        mixed.disabled = true;
        ghostSelect.prepend(mixed);
      }
      rows.ghosts = row('The ghosts are played by', ghostSelect, 'the classic rules');
      picks.append(rows.pacman, rows.ghosts);
      card.append(picks);
    }
    card.append(el('p', 'J hands Pac-Man to the AI or back during a game; each character\'s model can also be changed on the panel cards.', 'muted small keys'));
    card.append(
      el(
        'p',
        me.mode === 'player'
          ? 'A game usually costs about $0.01 from your Opper wallet per side the AI plays (Clef about $0.02); Beat the AI is free.'
          : me.devProvider === 'typesafe'
            ? 'Calls use your TypeSafe key from .env.'
            : 'Calls use the local key from .env.',
        'muted',
      ),
    );
  }
  const icon = el('span', '▶ ');
  icon.setAttribute('aria-hidden', 'true');
  const label = el('span', signedOut ? 'Play free' : 'Play');
  play.append(icon, label);
  play.addEventListener('click', opts.onPlay);
  card.append(play, el('p', 'or press Space / Enter', 'muted small keys'));
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
  select(signedOut ? { pacman: 'you', ghosts: 'classic' } : opts.sides);
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
