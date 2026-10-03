import { FRUIT_TILE, HOUSE_TILES } from './layout';
import { DIR_VEC } from './maze';
import { actorPosition, DYING_SECONDS, isJevDriven, type Actor, type GameState, type Ghost } from './sim';
import { ACTOR_IDS, GHOST_IDS, type Dir, type GhostId } from './types';

export const TILE = 20;
export const GHOST_COLORS: Record<GhostId, string> = { blinky: '#ff0000', pinky: '#ffb8ff', inky: '#00ffff', clyde: '#ffb852' };
export const FRUIT_EMOJI: Record<string, string> = {
  cherry: '🍒', strawberry: '🍓', orange: '🍊', apple: '🍎', melon: '🍈', galaxian: '🚀', bell: '🔔', key: '🔑',
};
const ANGLE: Record<Dir, number> = { right: 0, down: Math.PI / 2, left: Math.PI, up: -Math.PI / 2 };
const px = (tileCoord: number) => (tileCoord + 0.5) * TILE;

export function drawGame(ctx: CanvasRenderingContext2D, state: GameState, t: number): void {
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  drawMaze(ctx, state, t);
  if (state.fruit) drawText(ctx, FRUIT_EMOJI[state.fruit.kind] ?? '?', state.fruit.tile.x, state.fruit.tile.y, '#fff', 16, 'serif');
  for (const id of GHOST_IDS) drawGhost(ctx, state, state.ghosts[id], t);
  if (state.status !== 'gameover') drawPacman(ctx, state, t);
  for (const id of ACTOR_IDS) {
    const a = id === 'pacman' ? state.pacman : state.ghosts[id];
    if (a.waiting && isJevDriven(state, id)) drawThinking(ctx, a, t);
  }
  for (const p of state.popups) drawText(ctx, p.text, p.tile.x, p.tile.y, '#00ffff', 11);
  const banner = { ready: ['READY!', '#ffd800'], gameover: ['GAME OVER', '#ff0000'], levelclear: ['LEVEL CLEAR', '#ffffff'] } as const;
  if (state.status in banner) {
    const [text, color] = banner[state.status as keyof typeof banner];
    drawText(ctx, text, FRUIT_TILE.x + 0.5, FRUIT_TILE.y, color, 16);
  }
}

function drawMaze(ctx: CanvasRenderingContext2D, state: GameState, t: number): void {
  const { layout, maze } = state;
  const isWall = (x: number, y: number) => {
    const c = layout[y]?.[x];
    return c === undefined || c === '#';
  };
  ctx.strokeStyle = '#2121de';
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let y = 0; y < maze.height; y++) {
    for (let x = 0; x < maze.width; x++) {
      const c = layout[y][x];
      if (c === '#') {
        const l = x * TILE, r = (x + 1) * TILE, top = y * TILE, b = (y + 1) * TILE;
        if (!isWall(x, y - 1)) { ctx.moveTo(l, top + 1); ctx.lineTo(r, top + 1); }
        if (!isWall(x, y + 1)) { ctx.moveTo(l, b - 1); ctx.lineTo(r, b - 1); }
        if (!isWall(x - 1, y)) { ctx.moveTo(l + 1, top); ctx.lineTo(l + 1, b); }
        if (!isWall(x + 1, y)) { ctx.moveTo(r - 1, top); ctx.lineTo(r - 1, b); }
      } else if (c === '-') {
        ctx.fillStyle = '#ffb8ff';
        ctx.fillRect(x * TILE, y * TILE + TILE / 2 - 2, TILE, 4);
      }
    }
  }
  ctx.stroke();
  // Pellets are a separate pass: dot() calls beginPath(), which would discard the wall path above.
  for (let y = 0; y < maze.height; y++) {
    for (let x = 0; x < maze.width; x++) {
      const k = maze.key({ x, y });
      if (maze.pellets.has(k)) dot(ctx, x, y, 2);
      else if (maze.powerPellets.has(k) && Math.floor(t * 4) % 2 === 0) dot(ctx, x, y, 6);
    }
  }
}

function dot(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  ctx.fillStyle = '#ffb8ae';
  ctx.beginPath();
  ctx.arc(px(x), px(y), r, 0, Math.PI * 2);
  ctx.fill();
}

function drawPacman(ctx: CanvasRenderingContext2D, state: GameState, t: number): void {
  const p = actorPosition(state.pacman);
  const mouth =
    state.status === 'dying'
      ? Math.min(Math.PI, (1 - state.statusTimer / DYING_SECONDS) * Math.PI)
      : 0.25 * Math.PI * Math.abs(Math.sin(t * 12));
  const a = ANGLE[state.pacman.dir];
  ctx.fillStyle = '#ffd800';
  ctx.beginPath();
  ctx.moveTo(px(p.x), px(p.y));
  ctx.arc(px(p.x), px(p.y), TILE * 0.45, a + mouth, a + 2 * Math.PI - mouth);
  ctx.closePath();
  ctx.fill();
}

function drawGhost(ctx: CanvasRenderingContext2D, state: GameState, g: Ghost, t: number): void {
  const p = g.state === 'house' ? { x: HOUSE_TILES[g.id].x, y: HOUSE_TILES[g.id].y + 0.15 * Math.sin(t * 6) } : actorPosition(g);
  const x = px(p.x), y = px(p.y), r = TILE * 0.45;
  if (g.state !== 'eaten') {
    const flashing = g.state === 'frightened' && state.frightLeft < 2 && Math.floor(t * 5) % 2 === 0;
    ctx.fillStyle = g.state === 'frightened' ? (flashing ? '#ffffff' : '#2121ff') : GHOST_COLORS[g.id];
    ctx.beginPath();
    ctx.arc(x, y - r * 0.1, r, Math.PI, 0);
    ctx.lineTo(x + r, y + r);
    [0.66, 0.33, 0, -0.33, -0.66, -1].forEach((f, i) => ctx.lineTo(x + r * f, y + r * (i % 2 === 0 ? 0.6 : 1)));
    ctx.closePath();
    ctx.fill();
  }
  if (g.state === 'frightened') {
    ctx.fillStyle = '#ffb8ae';
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.arc(x + side * r * 0.35, y - r * 0.2, r * 0.12, 0, Math.PI * 2);
      ctx.fill();
    }
    return;
  }
  const v = DIR_VEC[g.dir];
  for (const side of [-1, 1]) {
    const ex = x + side * r * 0.35, ey = y - r * 0.2;
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(ex, ey, r * 0.28, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#2121ff';
    ctx.beginPath();
    ctx.arc(ex + v.x * r * 0.12, ey + v.y * r * 0.12, r * 0.14, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawThinking(ctx: CanvasRenderingContext2D, a: Actor, t: number): void {
  const p = actorPosition(a);
  const x = px(p.x), y = px(p.y) - TILE;
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.beginPath();
  ctx.roundRect(x - 12, y - 6, 24, 12, 6);
  ctx.fill();
  const active = Math.floor(t * 4) % 3;
  for (let i = 0; i < 3; i++) {
    ctx.fillStyle = i === active ? '#000' : '#888';
    ctx.beginPath();
    ctx.arc(x - 6 + i * 6, y, 1.8, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color: string, size: number, family = 'ui-monospace, monospace'): void {
  ctx.fillStyle = color;
  ctx.font = `bold ${size}px ${family}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, px(x), px(y));
}
