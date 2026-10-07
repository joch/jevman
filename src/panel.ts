import { modelName } from '../shared/models';
import { ACTOR_NAMES, type Decision } from './brain';
import { GHOST_COLORS } from './render';
import type { SchedulerEvent } from './scheduler';
import { jevActors, type GameState } from './sim';
import { modelSelect, type ModelPicking } from './picker';
import { ACTOR_IDS, DIRS, type ActorId, type Dir } from './types';

const COLORS: Record<ActorId, string> = { pacman: '#ffd800', ...GHOST_COLORS };
const ARROWS: Record<Dir, string> = { up: '↑', left: '←', down: '↓', right: '→' };
const LOG_LIMIT = 80;

interface Card {
  el: HTMLElement;
  status: HTMLElement;
  meta: HTMLElement;
  bars: Record<Dir, { row: HTMLElement; fill: HTMLElement; pct: HTMLElement }>;
  /** Which model plays this character; shown while the AI plays it. */
  model?: HTMLSelectElement;
}

export class Panel {
  private readonly cards = new Map<ActorId, Card>();
  /** Whether jev played each character at the last updateActors. */
  private readonly played = new Map<ActorId, boolean>();
  private readonly banner: HTMLElement;
  private readonly totalsEl: HTMLElement;
  private readonly log: HTMLElement;
  private readonly totals = { calls: 0, decisions: 0, fallbacks: 0, stale: 0, inputTokens: 0, outputTokens: 0, cost: 0, costEstimated: false, latencyMs: 0 };

  /** `caption` labels the panel, e.g. "recorded game" so demo totals don't read as the visitor's own spend. */
  private readonly models: ModelPicking | undefined;
  /** Card dropdowns appear once a game runs; before that the Play dialog is where models are picked. */
  private pickersOn = false;

  /**
   * `models` adds a model dropdown to each card the AI plays (live games only; a recording can't change). `playedBy`
   * names the model of a recording, so the panel says plainly who is deciding.
   */
  constructor(private readonly root: HTMLElement, opts: { caption?: string; models?: ModelPicking; playedBy?: string } = {}) {
    this.models = opts.models;
    const explain = opts.playedBy
      ? `${opts.playedBy} is playing this recorded game as Pac-Man. The bars show the odds it gave each way at its next junction; the brightest is the way it chose.`
      : 'The bars show the odds the AI gave each way at its next junction; the brightest is the way it chose.';
    root.innerHTML = `<h2>AI decisions</h2><p class="explain"></p><div class="banner" role="alert" hidden></div><div class="note" role="status" hidden></div><details class="totals"><summary></summary><div class="grid"></div></details><div class="cards"></div><h3>Decision log</h3><ol class="log"></ol>`;
    // The model name comes from a recording file: set as text, never as HTML.
    root.querySelector<HTMLElement>('.explain')!.textContent = explain;
    if (opts.caption) {
      const caption = document.createElement('span');
      caption.className = 'caption';
      caption.textContent = opts.caption;
      root.querySelector('h2')!.append(' ', caption);
    }
    this.banner = root.querySelector<HTMLElement>('.banner')!;
    this.totalsEl = root.querySelector<HTMLElement>('.totals')!;
    this.log = root.querySelector<HTMLElement>('.log')!;
    const cards = root.querySelector<HTMLElement>('.cards')!;
    for (const id of ACTOR_IDS) {
      const el = document.createElement('section');
      el.className = 'card';
      el.style.setProperty('--actor', COLORS[id]);
      el.innerHTML =
        `<header><span class="name">${ACTOR_NAMES[id]}</span><span class="status"></span></header>` +
        DIRS.map((d) => `<div class="bar" data-dir="${d}"><span class="arrow">${ARROWS[d]}</span><span class="track"><span class="fill"></span></span><span class="pct">–</span></div>`).join('') +
        `<footer class="meta">no decision yet</footer>`;
      if (id === 'pacman' && opts.playedBy) el.querySelector('.name')!.textContent = `${ACTOR_NAMES[id]} · ${opts.playedBy}`;
      cards.append(el);
      const bars = Object.fromEntries(
        DIRS.map((d) => {
          const row = el.querySelector<HTMLElement>(`[data-dir="${d}"]`)!;
          return [d, { row, fill: row.querySelector<HTMLElement>('.fill')!, pct: row.querySelector<HTMLElement>('.pct')! }];
        }),
      ) as Card['bars'];
      let model: HTMLSelectElement | undefined;
      if (opts.models) {
        const p = opts.models;
        model = modelSelect(p, p.choice()[id], (m) => p.onChange({ ...p.choice(), [id]: m }), `Model playing ${ACTOR_NAMES[id]}`);
        model.hidden = true;
        // Hand the keys back to the game (arrows would otherwise step through the models).
        model.addEventListener('change', () => model?.blur());
        el.querySelector('header')!.after(model);
      }
      this.cards.set(id, { el, status: el.querySelector<HTMLElement>('.status')!, meta: el.querySelector<HTMLElement>('.meta')!, bars, model });
    }
    this.renderTotals();
  }

  handle(e: SchedulerEvent): void {
    switch (e.type) {
      case 'call':
        this.totals.calls += 1;
        if (Number.isFinite(e.usage.input_tokens)) this.totals.inputTokens += e.usage.input_tokens;
        if (Number.isFinite(e.usage.output_tokens)) this.totals.outputTokens += e.usage.output_tokens;
        if (e.costUsd !== null && Number.isFinite(e.costUsd)) this.totals.cost += e.costUsd;
        if (e.costEstimated) this.totals.costEstimated = true;
        if (Number.isFinite(e.latencyMs)) this.totals.latencyMs += e.latencyMs;
        this.banner.hidden = true;
        break;
      case 'error':
        this.banner.textContent = e.message;
        this.banner.hidden = false;
        break;
      case 'stale':
        this.totals.stale += 1;
        this.addLog(`${ACTOR_NAMES[e.actor]}: late answer dropped (situation changed)`, 'stale');
        break;
      case 'decision':
        this.showDecision(e);
        break;
      case 'superseded':
        this.totals.decisions -= 1;
        if (e.decision.source === 'fallback') this.totals.fallbacks -= 1;
        this.totals.stale += 1;
        this.addLog(`${ACTOR_NAMES[e.decision.actor]}: unused answer dropped (situation changed)`, 'stale');
        break;
    }
    this.renderTotals();
  }

  updateActors(state: GameState): void {
    for (const id of ACTOR_IDS) {
      const ghost = id === 'pacman' ? null : state.ghosts[id];
      const actor = ghost ?? state.pacman;
      const text =
        id === 'pacman' && state.pacmanControl === 'keyboard' ? 'keyboard'
        : ghost?.state === 'house' ? 'in house'
        : ghost?.state === 'eaten' ? 'eyes → home'
        : ghost && !jevActors(state).includes(id) ? (ghost.state === 'frightened' ? 'scripted · frightened' : 'scripted')
        : state.status === 'playing' && actor.waiting ? 'thinking…'
        : ghost?.state === 'frightened' ? 'frightened'
        : 'moving';
      const card = this.cards.get(id)!;
      if (card.status.textContent !== text) {
        card.status.textContent = text;
        card.status.dataset.state = text;
      }
      // A character jev doesn't play shows who steers it instead of a stale jev decision.
      const played = jevActors(state).includes(id);
      if (card.model) card.model.hidden = !(played && this.pickersOn);
      if (played !== this.played.get(id)) {
        this.played.set(id, played);
        this.clearCard(id, played ? 'no decision yet' : ghost ? 'classic ghost rules, no AI' : 'steered by you');
      }
    }
  }

  /** Empty bars and a note on who steers: for a character jev stopped playing (or never played this game). */
  private clearCard(id: ActorId, meta: string): void {
    const card = this.cards.get(id)!;
    for (const dir of DIRS) {
      const bar = card.bars[dir];
      bar.row.classList.remove('chosen', 'disabled');
      bar.fill.style.width = '0%';
      bar.pct.textContent = '–';
    }
    card.meta.textContent = meta;
    card.meta.classList.remove('fallback');
    card.el.classList.remove('fallback');
  }

  /** What the note is about (e.g. a model, a side switch), so only that thing's success clears it. */
  private alertKey: string | null = null;

  /** A note above the cards that stays until replaced or cleared (call errors use the banner, which clears on success). */
  alert(text: string, key: string): void {
    const note = this.root.querySelector<HTMLElement>('.note')!;
    note.textContent = text;
    note.hidden = false;
    this.alertKey = key;
  }

  /** Clears the note if it is about `key`. */
  clearAlert(key: string): void {
    if (this.alertKey !== key) return;
    this.root.querySelector<HTMLElement>('.note')!.hidden = true;
    this.alertKey = null;
  }

  enableModelPickers(): void {
    this.pickersOn = true;
  }

  /** Show the current model choice in the card dropdowns (after a change in the Play dialog or another card). */
  syncModels(): void {
    if (!this.models) return;
    const choice = this.models.choice();
    for (const [id, card] of this.cards) if (card.model) card.model.value = choice[id];
  }

  private showDecision(e: Extract<SchedulerEvent, { type: 'decision' }>): void {
    const d = e.decision;
    this.totals.decisions += 1;
    if (d.source === 'fallback') this.totals.fallbacks += 1;
    this.drawCard(
      d,
      d.source === 'jev'
        ? `${d.model ? modelName(d.model) : 'jev'} · confidence ${d.confidence === null ? '?' : d.confidence.toFixed(2)} · ${e.latencyMs ?? '?'} ms`
        : `FALLBACK (${d.reason}) · greedy rule, not the model`,
      d.source === 'fallback',
    );
    const p = d.probabilities[d.choice];
    this.addLog(
      `${ACTOR_NAMES[d.actor]} @(${d.tile.x},${d.tile.y}) ${ARROWS[d.choice]} ${d.choice}` +
        (p !== undefined ? ` ${Math.round(p * 100)}%` : '') +
        (d.escape ? ' · escape (mid-corridor)' : '') +
        (d.source === 'fallback' ? ` · FALLBACK (${d.reason})` : '') +
        (e.fruitOnBoard ? ' · fruit on board' : ''),
      d.source === 'fallback' ? 'fallback' : d.actor,
    );
  }

  private drawCard(d: Decision, meta: string, flagged: boolean): void {
    const card = this.cards.get(d.actor)!;
    for (const dir of DIRS) {
      const bar = card.bars[dir];
      const offered = d.options.includes(dir);
      const p = d.probabilities[dir];
      bar.row.classList.toggle('disabled', !offered);
      bar.row.classList.toggle('chosen', dir === d.choice);
      const width = p ?? (dir === d.choice ? 1 : 0);
      bar.fill.style.width = `${Math.round(width * 100)}%`;
      bar.pct.textContent = !offered ? '' : p === undefined ? (dir !== d.choice ? '–' : d.source === 'fallback' ? 'fallback' : 'pick') : `${Math.round(p * 100)}%`;
    }
    card.meta.textContent = meta;
    card.meta.classList.toggle('fallback', flagged);
    card.el.classList.toggle('fallback', flagged);
  }

  private addLog(text: string, cls: string): void {
    const li = document.createElement('li');
    li.textContent = text;
    li.className = cls;
    this.log.prepend(li);
    while (this.log.childElementCount > LOG_LIMIT) this.log.lastElementChild!.remove();
  }

  private renderTotals(): void {
    const t = this.totals;
    const mean = t.calls ? Math.round(t.latencyMs / t.calls) : 0;
    const cells: [string, string][] = [
      ['calls', String(t.calls)],
      ['decisions', String(t.decisions)],
      ['fallbacks', String(t.fallbacks)],
      ['stale', String(t.stale)],
      ['tokens in', String(t.inputTokens)],
      ['tokens out', String(t.outputTokens)],
      ['cost', `${t.costEstimated ? '≈' : ''}$${t.cost.toFixed(5)}`],
      ['mean latency', `${mean} ms`],
    ];
    // One line by default; the full numbers a click away (the <details> keeps itself open or closed).
    this.totalsEl.querySelector('summary')!.textContent =
      `${t.decisions} decisions · ${t.fallbacks} fallbacks · ${t.costEstimated ? '≈' : ''}$${t.cost.toFixed(4)} · ${mean} ms`;
    this.totalsEl.querySelector('.grid')!.replaceChildren(
      ...cells.map(([label, value]) => {
        const cell = document.createElement('div');
        const name = document.createElement('span');
        name.textContent = label;
        cell.append(name, value);
        return cell;
      }),
    );
  }
}
