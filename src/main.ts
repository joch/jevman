import './style.css';
import { fetchMe, renderAccount, takeAuthError } from './auth';
import { Panel } from './panel';
import { drawGame, FRUIT_EMOJI, TILE } from './render';
import { Replay, type Recording } from './replay';
import { Scheduler } from './scheduler';
import { createGame, fruitForLevel, step, type GameState } from './sim';
import { createHttpTransport } from './transport';
import type { Dir } from './types';

const KEYS: Record<string, Dir> = {
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
  w: 'up', s: 'down', a: 'left', d: 'right',
};
const DEMO_LOOP_PAUSE_MS = 3000;
const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

let state: GameState = createGame();
const canvas = $<HTMLCanvasElement>('#game');
canvas.width = state.maze.width * TILE;
canvas.height = state.maze.height * TILE;
const ctx = canvas.getContext('2d')!;
let panel = new Panel($('#panel'));

const accountEl = $('#account');
const me = await fetchMe();
const authError = takeAuthError();

// Signed-out visitors watch a recorded jev game instead of a live one (no /api/decide calls).
let demo: { replay: Replay; acc: number; endAt: number | null; rec: Recording } | null = null;
if (me.mode === 'none') {
  const rec: Recording | null = await fetch('/demo/jev-demo.json')
    .then((r) => (r.ok ? (r.json() as Promise<Recording>) : null))
    .catch(() => null);
  if (rec) {
    demo = { replay: new Replay(rec), acc: 0, endAt: null, rec };
    state = demo.replay.state;
  }
}
renderAccount(accountEl, {
  kind: me.mode === 'player' ? 'player' : me.mode === 'dev' ? 'dev' : demo ? 'demo' : 'signed-out',
  me,
  notice: authError ?? undefined,
});
let signedOutShown = me.mode === 'none';
const transport = createHttpTransport({
  onSignedOut: () => {
    if (signedOutShown) return; // render the aria-live region once per signed-in -> signed-out transition
    signedOutShown = true;
    renderAccount(accountEl, { kind: 'signed-out', me: { ...me, mode: 'none' } });
  },
  onWalletEmpty: () => {},
});

let clockMs = 0; // advances only while unpaused, so pausing never triggers timeouts
let paused = false;
let speed = 1;
let last = performance.now();
const scheduler = new Scheduler({ transport, now: () => clockMs, onEvent: (e) => panel.handle(e) });

const toggleBtn = $<HTMLButtonElement>('#toggle-pacman');
const pauseBtn = $<HTMLButtonElement>('#pause');
const speedIn = $<HTMLInputElement>('#speed');
const speedOut = $('#speed-out');
const restartBtn = $<HTMLButtonElement>('#restart');
const hud = { score: $('#score'), level: $('#level'), lives: $('#lives'), fruit: $('#fruit-hud') };

if (demo) {
  for (const control of [toggleBtn, restartBtn, speedIn]) {
    control.disabled = true;
    control.title = 'Sign in to play live';
  }
}

function togglePacman(): void {
  if (demo) return;
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
  if (demo) return;
  state = createGame({ pacmanControl: state.pacmanControl });
  scheduler.reset();
}

toggleBtn.addEventListener('click', togglePacman);
pauseBtn.addEventListener('click', togglePause);
restartBtn.addEventListener('click', restart);
speedIn.addEventListener('input', () => {
  speed = Number(speedIn.value);
  speedOut.textContent = `${speed.toFixed(2)}×`;
});
window.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey || typeof e.key !== 'string') return;
  if (e.target instanceof HTMLElement && ['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return;
  const dir = KEYS[e.key] ?? KEYS[e.key.toLowerCase()];
  if (dir) {
    if (demo) return; // the recorded game takes no input
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
    if (demo) {
      if (demo.replay.done) {
        demo.endAt ??= now;
        if (now - demo.endAt > DEMO_LOOP_PAUSE_MS) {
          demo = { replay: new Replay(demo.rec), acc: 0, endAt: null, rec: demo.rec };
          state = demo.replay.state;
          panel = new Panel($('#panel'));
        }
      } else {
        demo.acc += dt;
        while (!demo.replay.done && demo.acc >= demo.rec.frames[demo.replay.frame]) {
          demo.acc -= demo.rec.frames[demo.replay.frame];
          for (const e of demo.replay.stepFrame()) panel.handle(e);
        }
      }
    } else {
      clockMs += dt * 1000;
      scheduler.update(state);
      step(state, dt * speed, scheduler);
    }
  }
  drawGame(ctx, state, now / 1000, paused);
  panel.updateActors(state);
  updateHud();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
