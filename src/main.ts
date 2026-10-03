import './style.css';
import { Panel } from './panel';
import { drawGame, FRUIT_EMOJI, TILE } from './render';
import { Scheduler } from './scheduler';
import { createGame, fruitForLevel, step, type GameState } from './sim';
import { httpTransport } from './transport';
import type { Dir } from './types';

const KEYS: Record<string, Dir> = {
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
  w: 'up', s: 'down', a: 'left', d: 'right',
};
const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

let state: GameState = createGame();
const canvas = $<HTMLCanvasElement>('#game');
canvas.width = state.maze.width * TILE;
canvas.height = state.maze.height * TILE;
const ctx = canvas.getContext('2d')!;
const panel = new Panel($('#panel'));

let clockMs = 0; // advances only while unpaused, so pausing never triggers timeouts
let paused = false;
let speed = 1;
let last = performance.now();
const scheduler = new Scheduler({ transport: httpTransport, now: () => clockMs, onEvent: (e) => panel.handle(e) });

const toggleBtn = $<HTMLButtonElement>('#toggle-pacman');
const pauseBtn = $<HTMLButtonElement>('#pause');
const speedIn = $<HTMLInputElement>('#speed');
const speedOut = $('#speed-out');
const hud = { score: $('#score'), level: $('#level'), lives: $('#lives'), fruit: $('#fruit-hud') };

function togglePacman(): void {
  state.pacmanControl = state.pacmanControl === 'jev' ? 'keyboard' : 'jev';
  state.keyDir = null;
  toggleBtn.textContent = `Pac-Man: ${state.pacmanControl}`;
  toggleBtn.setAttribute('aria-pressed', String(state.pacmanControl === 'jev'));
}

function togglePause(): void {
  paused = !paused;
  pauseBtn.textContent = paused ? 'Resume' : 'Pause';
}

function restart(): void {
  state = createGame({ pacmanControl: state.pacmanControl });
  scheduler.reset();
}

toggleBtn.addEventListener('click', togglePacman);
pauseBtn.addEventListener('click', togglePause);
$('#restart').addEventListener('click', restart);
speedIn.addEventListener('input', () => {
  speed = Number(speedIn.value);
  speedOut.textContent = `${speed.toFixed(2)}×`;
});
window.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey || typeof e.key !== 'string') return;
  if (e.target instanceof HTMLElement && ['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return;
  const dir = KEYS[e.key] ?? KEYS[e.key.toLowerCase()];
  if (dir) {
    state.keyDir = dir;
    e.preventDefault();
    return;
  }
  if (e.repeat) return;
  const k = e.key.toLowerCase();
  if (k === 'j') togglePacman();
  else if (k === 'p') togglePause();
  else if (k === 'r') restart();
});

const setText = (el: HTMLElement, text: string) => {
  if (el.textContent !== text) el.textContent = text;
};

function updateHud(): void {
  const fruit = fruitForLevel(state.level);
  setText(hud.score, String(state.score));
  setText(hud.level, String(state.level));
  setText(hud.lives, String(state.lives));
  setText(hud.fruit, `${FRUIT_EMOJI[fruit.kind]} ${fruit.points}`);
}

function frame(now: number): void {
  const dt = Math.max(0, Math.min(0.05, (now - last) / 1000));
  last = now;
  if (!paused) {
    clockMs += dt * 1000;
    scheduler.update(state);
    step(state, dt * speed, scheduler);
  }
  drawGame(ctx, state, now / 1000, paused);
  panel.updateActors(state);
  updateHud();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
