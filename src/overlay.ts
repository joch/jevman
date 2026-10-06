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

/** The main thing to do: watch a model play Pac-Man against the classic ghosts. */
export const WATCH: Sides = { pacman: 'ai', ghosts: 'classic' };

/** The other ways to play, offered smaller below watching. */
export const OTHER_GAMES: { sides: Sides; title: string }[] = [
  { sides: { pacman: 'you', ghosts: 'classic' }, title: 'Beat the AI' },
  { sides: { pacman: 'you', ghosts: 'ai' }, title: 'Play against an AI' },
  { sides: { pacman: 'ai', ghosts: 'ai' }, title: 'AI vs AI' },
];

const sameSides = (a: Sides, b: Sides) => a.pacman === b.pacman && a.ghosts === b.ghosts;

/** The dialog's heading for a choice of sides. */
export const titleFor = (sides: Sides): string => (sameSides(sides, WATCH) ? 'Watch an AI play' : OTHER_GAMES.find((g) => sameSides(g.sides, sides))!.title);

/** Which side the model chips pick: Pac-Man's model when the AI plays him, else the ghosts', else none. */
export const chipsPick = (sides: Sides): 'pacman' | 'ghosts' | null => (sides.pacman === 'ai' ? 'pacman' : sides.ghosts === 'ai' ? 'ghosts' : null);

function signInButton(me: Me, primary: boolean): HTMLButtonElement {
  const b = el('button', 'Sign in with Opper', primary ? 'primary' : 'signin');
  if (me.loginAvailable) b.addEventListener('click', signIn);
  else {
    // Login with Opper isn't configured here (its route answers 503): don't offer a broken action.
    b.disabled = true;
    b.title = 'Login with Opper is not configured on this server';
  }
  return b;
}

/**
 * The card before a live game. Watching an AI play is the main thing: pick the model with one click, then Watch.
 * Playing yourself, against AI ghosts and AI vs AI are offered smaller below; the model chips always pick "the AI"
 * of the chosen game. Signed out, watching live needs signing in, and the free game (you against the classic ghosts)
 * is the one thing that can be played.
 */
export function showPlay(
  root: HTMLElement,
  me: Me,
  opts: {
    sides: Sides;
    onSelect: (sides: Sides) => void;
    onPlay: () => void;
    models?: ModelPicking;
    /** Leaderboard averages per model, for "jev averages 3,181 points" (read on every render: they load later). */
    averages?: () => { model: string; meanScore: number }[] | undefined;
    onClose?: () => void;
  },
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
  const title = el('h2', 'Watch an AI play');
  card.append(title);
  const play = el('button', undefined, signedOut ? 'secondary' : 'primary');
  const icon = el('span', '▶ ');
  icon.setAttribute('aria-hidden', 'true');
  const label = el('span');
  play.append(icon, label);
  play.addEventListener('click', opts.onPlay);
  let sides: Sides = signedOut ? { pacman: 'you', ghosts: 'classic' } : opts.sides;
  const playLabel = () => (signedOut ? 'Play free' : sides.pacman === 'ai' ? 'Watch' : 'Play');
  /** Shows `sides` as chosen (set once the signed-in controls exist). */
  let render = () => {};
  /** Signed out: the main action, which gets the focus (when login is configured). */
  let signInBtn: HTMLButtonElement | null = null;
  /** "Waking up …" while Play waits for the models; it outlasts any re-render. */
  let busyNote: string | null = null;

  if (signedOut) {
    card.append(el('p', 'Sign in with Opper and pick a model to watch it play live. Calls bill your own Opper wallet, about $0.01 a game.', 'muted'));
    signInBtn = signInButton(me, true);
    card.append(signInBtn);
    const more = el('div', undefined, 'more');
    more.append(el('h3', 'Or play yourself'), el('p', 'Free, no sign-in: you against the classic ghosts. See which AIs you beat.', 'muted small'), play);
    card.append(more);
  } else {
    const m = opts.models;
    const chips = el('div', undefined, 'chips');
    chips.setAttribute('role', 'radiogroup');
    const line = el('p', undefined, 'muted describe');
    const others = el('div', undefined, 'others');
    others.setAttribute('role', 'radiogroup');
    others.setAttribute('aria-label', 'Other ways to play');
    const otherButtons = new Map<HTMLButtonElement, Sides>();
    const name = (id: string) => m?.options.find((o) => o.id === id)?.label ?? id;
    const ghostsMixed = () => !!m && !GHOST_IDS.every((id) => m.choice()[id] === m.choice().blinky);
    const choose = (next: Sides) => {
      sides = next;
      render();
      opts.onSelect(next);
    };
    // AI vs AI: the ghosts' model is picked in the sentence itself, so the card keeps its size. The line is built once
    // (text, then the dropdown); render only changes the text, so the dropdown keeps its focus.
    const lineText = document.createTextNode('');
    const ghostSelect = m ? modelSelect(m, m.choice().blinky, (model) => (m.onChange(setGhosts(m.choice(), model)), render()), 'Model playing the ghosts') : null;
    const mixedOption = new Option('per-ghost picks', '');
    mixedOption.disabled = true;
    line.append(lineText, ...(ghostSelect ? [ghostSelect] : []));
    render = () => {
      const pick = chipsPick(sides);
      const c = m?.choice();
      const picked = !c || !pick ? null : pick === 'pacman' ? c.pacman : ghostsMixed() ? null : c.blinky;
      title.textContent = titleFor(sides);
      chips.setAttribute('aria-label', pick === 'ghosts' ? 'Model playing the ghosts' : 'Model playing Pac-Man');
      for (const chip of chips.querySelectorAll<HTMLButtonElement>('button')) chip.setAttribute('aria-checked', String(chip.dataset.model === picked));
      chips.classList.toggle('off', pick === null);
      for (const [b, sd] of otherButtons) b.setAttribute('aria-checked', String(sameSides(sd, sides)));
      const aiVsAi = sides.pacman === 'ai' && sides.ghosts === 'ai';
      if (sameSides(sides, WATCH)) {
        const avg = opts.averages?.()?.find((a) => a.model === c?.pacman);
        lineText.data = avg
          ? `${name(c!.pacman)} averages ${avg.meanScore.toLocaleString('en-US')} points against the classic ghosts on the leaderboard.`
          : 'Against the classic arcade ghosts, the same game as on the leaderboard.';
      } else if (sides.pacman === 'you' && sides.ghosts === 'classic') {
        lineText.data = 'Free: you against the classic ghosts, the same game the AIs played. See which AIs you beat.';
      } else if (sides.pacman === 'you') {
        lineText.data = `You steer Pac-Man (arrows, WASD or swipe); ${ghostsMixed() ? 'your picks per ghost play' : `${name(c?.blinky ?? '')} plays`} the four ghosts.`;
      } else {
        lineText.data = `Pac-Man: ${name(c!.pacman)} · Ghosts: `;
      }
      if (ghostSelect) {
        ghostSelect.hidden = !aiVsAi;
        // Show the ghosts' model as it is now (a chip may have changed it), or that they have one each.
        if (ghostsMixed()) {
          if (!mixedOption.parentElement) ghostSelect.prepend(mixedOption);
          ghostSelect.value = '';
        } else {
          mixedOption.remove();
          ghostSelect.value = c!.blinky;
        }
      }
      label.textContent = busyNote ?? playLabel();
    };
    if (m) {
      for (const o of m.options) {
        const chip = el('button', o.label);
        chip.type = 'button';
        chip.setAttribute('role', 'radio');
        chip.dataset.model = o.id;
        chip.addEventListener('click', () => {
          const pick = chipsPick(sides);
          // In Beat the AI there is no AI to pick: a model chip goes back to watching that model. Switch first, so the
          // model change that follows warms it up.
          if (pick === null) choose(WATCH);
          if (pick === 'ghosts') m.onChange(setGhosts(m.choice(), o.id));
          else m.onChange({ ...m.choice(), pacman: o.id });
          render();
          play.focus({ preventScroll: true });
        });
        chips.append(chip);
      }
    }
    card.append(chips, line, play);
    const more = el('div', undefined, 'more');
    more.append(el('h3', 'More ways to play'));
    for (const g of OTHER_GAMES) {
      const b = el('button', g.title);
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.addEventListener('click', () => {
        choose(sameSides(g.sides, sides) ? WATCH : g.sides); // a second click goes back to watching
        play.focus({ preventScroll: true });
      });
      otherButtons.set(b, g.sides);
      others.append(b);
    }
    more.append(others);
    card.append(more);
    card.append(
      el(
        'p',
        me.mode === 'player'
          ? 'About $0.01 a game from your Opper wallet per side the AI plays (Clef about $0.02); Beat the AI is free.'
          : me.devProvider === 'typesafe'
            ? 'Calls use your TypeSafe key from .env.'
            : 'Calls use the local key from .env.',
        'muted small',
      ),
    );
    render();
  }
  label.textContent = playLabel();
  show(root, card, signInBtn && !signInBtn.disabled ? signInBtn : play);
  // aria-disabled, not disabled: the button keeps focus while models wake, and repeat presses are ignored by onPlay.
  const status = el('p', undefined, 'muted small');
  status.setAttribute('aria-live', 'polite');
  const busy = (note: string | null) => {
    play.toggleAttribute('aria-disabled', note !== null);
    play.setAttribute('aria-busy', String(note !== null));
    busyNote = note;
    label.textContent = note ?? playLabel();
    status.textContent = note ?? '';
  };
  card.append(status);
  const note = (text: string | null) => {
    status.textContent = text ?? '';
  };
  const select = (next: Sides) => {
    sides = next;
    render();
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
  card.append(again, el('p', 'or press Space / Enter', 'muted small'));
  show(root, card, again);
}
