import './style.css';
import { accountNotice, fetchMe, renderAccount, takeAuthError, walletNotice, type AccountView } from './auth';
import { DemoPlayer, loadRecording } from './demo';
import { hideOverlay, showGameOver, showPlay } from './overlay';
import { Panel } from './panel';
import { drawGame, FRUIT_EMOJI, TILE } from './render';
import { greedyChoice, optionFeatures } from './features';
import { Scheduler } from './scheduler';
import { createGame, fruitForLevel, jevActors, step, type Controls, type GameState } from './sim';
import { GameStats } from './stats';
import { createHttpTransport, warmUp } from './transport';
import { initialChoice, loadStoredChoice, modelOptions, requestModel, saveChoice, type ModelChoice } from './choice';
import type { ModelPicking } from './picker';
import { DEFAULT_MODEL, modelName } from '../shared/models';
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
/** Mirrors J presses into the Play card's mode choice until the first game starts. */
let selectPlayMode: ((mode: 'jev' | 'keyboard') => void) | null = null;
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
  // Which model plays each character: the server default until the player picks, remembered in this browser.
  const defaultModel = me.defaultModel ?? DEFAULT_MODEL;
  // `wanted` is what the player picked; `choice` is what plays. A newly picked model takes over once it is awake, so a
  // cold one doesn't turn the next moves into fallbacks.
  let wanted: ModelChoice = initialChoice(me, loadStoredChoice());
  let choice: ModelChoice = { ...wanted };
  const warming = new Map<string, { at: number; done: Promise<boolean>; ok?: boolean }>();
  const warm = (model: string): Promise<boolean> => {
    const w = warming.get(model);
    if (w && (w.ok === undefined || Date.now() - w.at < 120_000)) return w.done;
    const entry: { at: number; done: Promise<boolean>; ok?: boolean } = { at: Date.now(), done: Promise.resolve(false) };
    entry.done = warmUp(model === defaultModel ? undefined : model).then((ok) => ((entry.ok = ok), ok));
    warming.set(model, entry);
    return entry.done;
  };
  // Settled either way: a model that failed to wake still takes over, so its fallbacks show the problem.
  const isWarm = (model: string) => warming.get(model)?.ok !== undefined;
  const adopt = () => {
    choice = Object.fromEntries(Object.entries(wanted).map(([id, m]) => [id, isWarm(m) ? m : choice[id as keyof ModelChoice]])) as ModelChoice;
  };
  const playedModels = () => [...new Set(jevActors(state).map((id) => wanted[id]))];
  const picking: ModelPicking = {
    options: modelOptions(me),
    choice: () => wanted,
    onChange: (next) => {
      wanted = next;
      saveChoice(next);
      panel.syncModels();
      if (!started) choice = { ...next }; // Play waits for them below
      for (const m of new Set(Object.values(next))) void warm(m).then(adopt);
      adopt();
    },
  };
  panel = new Panel(panelEl, { models: picking });
  let stats = new GameStats();
  // One scheduler per game: answers still in flight from a restarted game reach its old scheduler and are ignored.
  // They share one in-flight counter, so restarting can't stack up more concurrent (billed) requests.
  const slots = { inFlight: 0 };
  const newScheduler = (gameStats: GameStats) =>
    new Scheduler({
      transport,
      slots,
      actors: jevActors,
      modelFor: (actor) => requestModel(choice, actor, defaultModel),
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
  // jev plays one side; the other side's characters follow the scripted rules.
  const controls: Controls = {
    decide: (point, s) => (jevActors(s).includes(point.actor) ? scheduler.decide(point, s) : greedyChoice(s, point, optionFeatures(s, point))),
  };
  // Nothing runs, and no jev call is made, until the player presses Play.
  let started = false;
  let gameOverShown = false;
  let waking = false;
  /** Play: wake the chosen models first (a few seconds when one has been idle), then start. */
  const play = (): void => {
    if (waking || started) return;
    const cold = playedModels().filter((m) => !isWarm(m));
    if (!cold.length) return begin();
    waking = true;
    playCard.busy(`Waking up ${cold.map(modelName).join(' and ')}…`);
    void Promise.all(cold.map(warm)).then(() => {
      waking = false;
      playCard.busy(null);
      choice = { ...wanted };
      begin();
    });
  };
  const begin = (): void => {
    started = true;
    selectPlayMode = null;
    restartBtn.disabled = false;
    overlayAction = null;
    hideOverlay(overlayEl);
  };

  const setPacmanControl = (control: 'jev' | 'keyboard'): void => {
    state.pacmanControl = control;
    state.keyDir = null;
    toggleBtn.textContent = `Pac-Man: ${control === 'jev' ? 'AI' : 'you'}`;
    toggleBtn.setAttribute('aria-pressed', String(control === 'jev'));
    selectPlayMode?.(control);
    for (const m of playedModels()) void warm(m).then(adopt);
  };
  const togglePacman = (): void => setPacmanControl(state.pacmanControl === 'jev' ? 'keyboard' : 'jev');
  const restart = (): void => {
    if (!started) return; // Restart / R must not skip the Play card
    state = createGame({ pacmanControl: state.pacmanControl });
    scheduler.reset();
    stats = new GameStats();
    scheduler = newScheduler(stats);
    panel = new Panel(panelEl, { models: picking });
    gameOverShown = false;
    paused = false;
    pauseBtn.textContent = 'Pause';
    begin();
  };
  restartBtn.disabled = true;
  const playCard = showPlay(overlayEl, me, { mode: state.pacmanControl, onSelect: setPacmanControl, onPlay: () => play(), models: picking });
  overlayAction = playCard.action;
  selectPlayMode = playCard.select;
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
    step(state, dt * speed, controls);
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
  // Space/Enter on a focused control (button, link, field) do that control's own thing; elsewhere they press the
  // overlay's button.
  const onControl = e.target instanceof Element && e.target.closest('a, button, input, select, textarea, [contenteditable], [tabindex]') !== null;
  if ((e.key === ' ' || e.key === 'Enter') && overlayAction && !onControl) {
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
