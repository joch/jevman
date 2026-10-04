import './style.css';
import { accountNotice, fetchMe, renderAccount, takeAuthError, walletNotice, type AccountView } from './auth';
import { DemoPlayer, loadRecording } from './demo';
import { hideOverlay, showGameOver, showPlay } from './overlay';
import { Panel } from './panel';
import { drawGame, FRUIT_EMOJI, TILE } from './render';
import { Scheduler } from './scheduler';
import { createGame, fruitForLevel, step, type GameState } from './sim';
import { GameStats } from './stats';
import { createHttpTransport } from './transport';
import type { Dir } from './types';

const KEYS: Record<string, Dir> = {
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
  w: 'up', s: 'down', a: 'left', d: 'right',
};
const DEMO_CAPTION = 'recorded game';
const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

// The recorded demo downloads alongside /api/me, so a signed-out visitor doesn't wait for two round trips.
const recording = loadRecording('/demo/jev-demo.json');
const me = await fetchMe();
const authError = takeAuthError();
const rec = me.mode === 'none' ? await recording : null;

let state: GameState = createGame();
const canvas = $<HTMLCanvasElement>('#game');
canvas.width = state.maze.width * TILE;
canvas.height = state.maze.height * TILE;
const ctx = canvas.getContext('2d')!;
const panelEl = $('#panel');
let panel = new Panel(panelEl);

const accountEl = $('#account');
let account: AccountView = { kind: me.mode === 'player' ? 'player' : me.mode === 'dev' ? 'dev' : 'signed-out', me };
const showAccount = (view: AccountView) => {
  account = view;
  renderAccount(accountEl, view);
};

let clockMs = 0; // advances only while unpaused, so pausing never triggers timeouts
let paused = false;
let speed = 1;
let last = performance.now();

const toggleBtn = $<HTMLButtonElement>('#toggle-pacman');
const pauseBtn = $<HTMLButtonElement>('#pause');
const speedIn = $<HTMLInputElement>('#speed');
const speedOut = $('#speed-out');
const restartBtn = $<HTMLButtonElement>('#restart');
const hud = { score: $('#score'), level: $('#level'), lives: $('#lives'), fruit: $('#fruit-hud') };

function togglePause(): void {
  if (!overlayEl.hidden) return; // nothing is running behind the Play / game-over card
  paused = !paused;
  pauseBtn.textContent = paused ? 'Resume' : 'Pause';
}
pauseBtn.addEventListener('click', togglePause);

const overlayEl = $('#overlay');
const keyActions = new Map<string, () => void>([['p', togglePause]]);
/** What Space/Enter does while an overlay is open (Play, Play again). */
let overlayAction: (() => void) | null = null;
let steer: ((dir: Dir) => void) | null = null;
let tick: (dt: number) => void;

if (rec) {
  // Signed-out visitors watch a recorded jev game: no input, no /api/decide calls, nothing billed.
  const demo = new DemoPlayer(rec, { onLoop: () => (panel = new Panel(panelEl, { caption: DEMO_CAPTION })) });
  state = demo.state;
  panel = new Panel(panelEl, { caption: DEMO_CAPTION });
  account = { ...account, kind: 'demo' };
  for (const control of [toggleBtn, restartBtn, speedIn]) {
    control.disabled = true;
    control.title = 'Sign in to play live';
  }
  speedIn.closest('label')!.hidden = true;
  $('.help').textContent = 'Recorded demo · P pause';
  tick = (dt) => {
    for (const e of demo.advance(dt)) panel.handle(e);
    state = demo.state;
  };
} else {
  let signedOutShown = me.mode === 'none';
  let walletShown = false;
  const transport = createHttpTransport({
    onSignedOut: () => {
      if (signedOutShown) return; // render the aria-live region once per signed-in -> signed-out transition
      signedOutShown = true;
      showAccount({ kind: 'signed-out', me: { ...me, mode: 'none' } });
    },
    onWalletEmpty: (url) => {
      if (walletShown) return; // one notice per page load, not one per failed call
      walletShown = true;
      showAccount({ ...account, ...walletNotice(url) });
    },
  });
  let stats = new GameStats();
  // One scheduler per game: answers still in flight from a restarted game reach its old scheduler and are ignored.
  // They share one in-flight counter, so restarting can't stack up more concurrent (billed) requests.
  const slots = { inFlight: 0 };
  const newScheduler = (gameStats: GameStats) =>
    new Scheduler({
      transport,
      slots,
      now: () => clockMs,
      onEvent: (e) => {
        if (gameStats !== stats) return;
        panel.handle(e);
        stats.onSchedulerEvent(e);
        // A request still in flight at game over reports afterwards; keep the card's numbers complete.
        if (gameOverShown && !overlayEl.hidden) showGameOver(overlayEl, stats.summary(state), restart);
      },
    });
  let scheduler = newScheduler(stats);
  // Nothing runs, and no jev call is made, until the player presses Play.
  let started = false;
  let gameOverShown = false;
  const begin = (): void => {
    started = true;
    restartBtn.disabled = false;
    overlayAction = null;
    hideOverlay(overlayEl);
  };

  const togglePacman = (): void => {
    state.pacmanControl = state.pacmanControl === 'jev' ? 'keyboard' : 'jev';
    state.keyDir = null;
    toggleBtn.textContent = `Pac-Man: ${state.pacmanControl}`;
    toggleBtn.setAttribute('aria-pressed', String(state.pacmanControl === 'jev'));
  };
  const restart = (): void => {
    if (!started) return; // Restart / R must not skip the Play card
    state = createGame({ pacmanControl: state.pacmanControl });
    scheduler.reset();
    stats = new GameStats();
    scheduler = newScheduler(stats);
    panel = new Panel(panelEl);
    gameOverShown = false;
    paused = false;
    pauseBtn.textContent = 'Pause';
    begin();
  };
  restartBtn.disabled = true;
  overlayAction = showPlay(overlayEl, me, begin);
  toggleBtn.addEventListener('click', togglePacman);
  restartBtn.addEventListener('click', restart);
  speedIn.addEventListener('input', () => {
    speed = Number(speedIn.value);
    speedOut.textContent = `${speed.toFixed(2)}×`;
  });
  keyActions.set('j', togglePacman).set('r', restart);
  steer = (dir) => {
    state.keyDir = dir;
  };
  tick = (dt) => {
    if (!started) return;
    clockMs += dt * 1000;
    scheduler.update(state);
    stats.beforeStep(state);
    step(state, dt * speed, scheduler);
    stats.afterStep(state, dt * speed);
    if (state.status === 'gameover' && !gameOverShown) {
      gameOverShown = true;
      overlayAction = restart;
      showGameOver(overlayEl, stats.summary(state), restart);
    }
  };
}
showAccount({ ...account, notice: accountNotice(me, authError, Boolean(rec)) });

window.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey || typeof e.key !== 'string') return;
  if (e.target instanceof HTMLElement && ['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return;
  const dir = KEYS[e.key] ?? KEYS[e.key.toLowerCase()];
  if (dir) {
    if (!steer) return; // the recorded game takes no input
    steer(dir);
    e.preventDefault();
    return;
  }
  if (e.repeat) return;
  // Space/Enter on a focused button already clicks it; elsewhere they press the overlay's button.
  if ((e.key === ' ' || e.key === 'Enter') && overlayAction && !(e.target instanceof HTMLButtonElement)) {
    e.preventDefault();
    overlayAction();
    return;
  }
  keyActions.get(e.key.toLowerCase())?.();
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
  if (!paused) tick(dt);
  drawGame(ctx, state, now / 1000, paused);
  panel.updateActors(state);
  updateHud();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
