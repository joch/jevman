import type { Decision } from './brain';
import { DIR_VEC } from './maze';
import { GHOST_COLORS, TILE } from './render';
import type { ActorId, Dir } from './types';

/** How long the odds stay on the board after a decision (fading out over the last part). */
export const SHOW_MS = 1600;

const COLOR: Record<ActorId, string> = { pacman: '#ffd800', ...GHOST_COLORS };

export interface Arrow {
  dir: Dir;
  /** 0..1, how sure the model was of this direction. */
  p: number;
  chosen: boolean;
}

/** The arrows to draw for a decision: one per option, longest for the likeliest. */
export function arrowsFor(d: Decision): Arrow[] {
  return d.options.map((dir) => ({
    dir,
    p: d.probabilities[dir] ?? (dir === d.choice ? 1 : 0),
    chosen: dir === d.choice,
  }));
}

/**
 * The models' thinking, drawn on the board: at each junction a model decides, small arrows show its odds per
 * direction and the % of its pick. Only the models' own decisions are drawn.
 */
export class Thinking {
  private readonly shown = new Map<ActorId, { d: Decision; at: number }>();

  add(d: Decision, now: number): void {
    if (d.source !== 'jev' || !Object.keys(d.probabilities).length) return;
    this.shown.set(d.actor, { d, at: now });
  }

  clear(): void {
    this.shown.clear();
  }

  draw(ctx: CanvasRenderingContext2D, now: number): void {
    for (const [actor, { d, at }] of this.shown) {
      const age = now - at;
      if (age > SHOW_MS) {
        this.shown.delete(actor);
        continue;
      }
      const alpha = age < SHOW_MS * 0.6 ? 1 : 1 - (age - SHOW_MS * 0.6) / (SHOW_MS * 0.4);
      const cx = (d.tile.x + 0.5) * TILE;
      const cy = (d.tile.y + 0.5) * TILE;
      ctx.save();
      ctx.globalAlpha = alpha;
      for (const a of arrowsFor(d)) {
        const v = DIR_VEC[a.dir];
        const len = 8 + a.p * 26;
        const color = COLOR[actor];
        ctx.strokeStyle = color;
        ctx.fillStyle = color;
        ctx.globalAlpha = alpha * (a.chosen ? 1 : 0.4 + a.p * 0.5);
        ctx.lineWidth = a.chosen ? 4 : 2.5;
        ctx.lineCap = 'round';
        // Start clear of the character standing on the junction.
        const x0 = cx + v.x * 12;
        const y0 = cy + v.y * 12;
        const x1 = cx + v.x * (12 + len);
        const y1 = cy + v.y * (12 + len);
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        ctx.stroke();
        // arrow head
        const hx = -v.y;
        const hy = v.x;
        ctx.beginPath();
        ctx.moveTo(x1 + v.x * 7, y1 + v.y * 7);
        ctx.lineTo(x1 + hx * 5.5, y1 + hy * 5.5);
        ctx.lineTo(x1 - hx * 5.5, y1 - hy * 5.5);
        ctx.closePath();
        ctx.fill();
        if (a.chosen) {
          ctx.globalAlpha = alpha;
          ctx.font = 'bold 12px ui-monospace, monospace';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          const tx = x1 + v.x * 20 + (v.x === 0 ? 18 : 0);
          const ty = y1 + v.y * 18 + (v.y === 0 ? -12 : 0);
          const label = `${Math.round(a.p * 100)}%`;
          ctx.fillStyle = 'rgba(0,0,0,0.8)';
          ctx.beginPath();
          ctx.roundRect(tx - 17, ty - 8, 34, 16, 4);
          ctx.fill();
          ctx.fillStyle = color;
          ctx.fillText(label, tx, ty);
        }
      }
      ctx.restore();
    }
  }
}
