import { ACTOR_NAMES } from './brain';
import { GHOST_COLORS } from './render';
import type { SchedulerEvent } from './scheduler';
import type { GameState } from './sim';
import { ACTOR_IDS, DIRS, type ActorId, type Dir } from './types';

const COLORS: Record<ActorId, string> = { pacman: '#ffd800', ...GHOST_COLORS };
const ARROWS: Record<Dir, string> = { up: '↑', left: '←', down: '↓', right: '→' };
const LOG_LIMIT = 80;

interface Card {
  el: HTMLElement;
  status: HTMLElement;
  meta: HTMLElement;
  bars: Record<Dir, { row: HTMLElement; fill: HTMLElement; pct: HTMLElement }>;
}

export class Panel {
  private readonly cards = new Map<ActorId, Card>();
  private readonly banner: HTMLElement;
  private readonly totalsEl: HTMLElement;
  private readonly log: HTMLElement;
  private readonly totals = { calls: 0, decisions: 0, fallbacks: 0, stale: 0, inputTokens: 0, outputTokens: 0, cost: 0, latencyMs: 0 };

  /** `caption` labels the panel, e.g. "recorded game" so demo totals don't read as the visitor's own spend. */
  constructor(root: HTMLElement, opts: { caption?: string } = {}) {
    root.innerHTML = `<h2>jev decisions</h2><div class="banner" role="alert" hidden></div><div class="totals"></div><div class="cards"></div><h3>Decision log</h3><ol class="log"></ol>`;
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
      cards.append(el);
      const bars = Object.fromEntries(
        DIRS.map((d) => {
          const row = el.querySelector<HTMLElement>(`[data-dir="${d}"]`)!;
          return [d, { row, fill: row.querySelector<HTMLElement>('.fill')!, pct: row.querySelector<HTMLElement>('.pct')! }];
        }),
      ) as Card['bars'];
      this.cards.set(id, { el, status: el.querySelector<HTMLElement>('.status')!, meta: el.querySelector<HTMLElement>('.meta')!, bars });
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
        : state.status === 'playing' && actor.waiting ? 'thinking…'
        : ghost?.state === 'frightened' ? 'frightened'
        : 'moving';
      const status = this.cards.get(id)!.status;
      if (status.textContent !== text) {
        status.textContent = text;
        status.dataset.state = text;
      }
    }
  }

  private showDecision(e: Extract<SchedulerEvent, { type: 'decision' }>): void {
    const d = e.decision;
    const card = this.cards.get(d.actor)!;
    this.totals.decisions += 1;
    if (d.source === 'fallback') this.totals.fallbacks += 1;
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
    card.meta.textContent =
      d.source === 'jev'
        ? `jev · confidence ${d.confidence === null ? '?' : d.confidence.toFixed(2)} · ${e.latencyMs ?? '?'} ms`
        : `FALLBACK (${d.reason}) · greedy rule, not jev`;
    card.meta.classList.toggle('fallback', d.source === 'fallback');
    card.el.classList.toggle('fallback', d.source === 'fallback');
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
      ['cost', `$${t.cost.toFixed(5)}`],
      ['mean latency', `${mean} ms`],
    ];
    this.totalsEl.replaceChildren(
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
