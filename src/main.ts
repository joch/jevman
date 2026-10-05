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
import { createHttpTransport, warmUp, type TransportHooks } from './transport';
import { initialChoice, loadStoredChoice, modelOptions, requestModel, saveChoice, type ModelChoice } from './choice';
import type { ModelPicking } from './picker';
import { effectiveChoice, ModelWarming } from './warming';
import { DEFAULT_MODEL, modelName } from '../shared/models';
import type { Dir } from './types';

const KEYS: Record<string, Dir> = {
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
  w: 'up', s: 'down', a: 'left', d: 'right',
};
const DEMO_CAPTION = 'recorded game';
const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

// The recorded demo downloads alongside /api/me; it plays when the page opens, for everyone.
const recording = loadRecording('/demo/jev-demo.json');
const me = await fetchMe();
const authError = takeAuthError();
const rec = await recording;

let state: GameState = createGame();
const canvas = $<HTMLCanvasElement>('#game');
canvas.width = state.maze.width * TILE;
canvas.height = state.maze.height * TILE;
const ctx = canvas.getContext('2d')!;
const panelEl = $('#panel');
let panel = new Panel(panelEl);

const accountEl = $('#account');
let account: AccountView = { kind: me.mode === 'player' ? 'player' : me.mode === 'dev' ? 'dev' : rec ? 'demo' : 'signed-out', me };
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
const playCta = $<HTMLButtonElement>('#play-cta');
const help = $('.help');
const hud = { score: $('#score'), level: $('#level'), lives: $('#lives'), fruit: $('#fruit-hud') };

function togglePause(): void {
  if (!overlayEl.hidden) return; // nothing is running behind the Play / game-over card
  paused = !paused;
  pauseBtn.textContent = paused ? 'Resume' : 'Pause';
}
pauseBtn.addEventListener('click', togglePause);

const overlayEl = $('#overlay');
const keyActions = new Map<string, () => void>([['p', togglePause]]);
/** What Space/Enter does while an overlay is open (Play, Play again), or on the demo (open the Play card). */
let overlayAction: (() => void) | null = null;
/** What Escape does: close the Play card and go back to the demo. */
let closeAction: (() => void) | null = null;
let steer: ((dir: Dir) => void) | null = null;
let tick: (dt: number) => void = () => {};

// The recorded game plays (no input, no /api/decide calls, nothing billed) until a live game starts.
let demo: DemoPlayer | null = null;
const LIVE_CONTROLS = [toggleBtn, restartBtn, speedIn];
function startDemo(r: NonNullable<typeof rec>): void {
  demo = new DemoPlayer(r, { onLoop: () => (panel = new Panel(panelEl, { caption: DEMO_CAPTION })) });
  state = demo.state;
  panel = new Panel(panelEl, { caption: DEMO_CAPTION });
  for (const control of LIVE_CONTROLS) {
    control.disabled = true;
    control.title = 'Press Play to play live';
  }
  speedIn.closest('label')!.hidden = true;
  help.textContent = 'Recorded game · press Play (or Space) to play live';
  playCta.hidden = false;
  tick = (dt) => {
    for (const e of demo!.advance(dt)) panel.handle(e);
    state = demo!.state;
  };
}
function endDemo(): void {
  demo = null;
  for (const control of LIVE_CONTROLS) {
    control.disabled = false;
    control.title = '';
  }
  speedIn.closest('label')!.hidden = false;
  help.textContent = 'Arrows/WASD steer when you play Pac-Man · J switch sides · P pause · R restart';
  playCta.hidden = true;
}

/** Opens the Play card (or the sign-in card); returns to the demo when closed. */
let openPlay: () => void;
const closePlay = () => {
  hideOverlay(overlayEl);
  overlayAction = openPlay;
  closeAction = null;
  playCta.hidden = false;
  playCta.focus({ preventScroll: true });
};

if (me.mode === 'none') {
  // Signed out: the demo, and Play offers sign-in.
  openPlay = () => {
    playCta.hidden = true;
    const card = showPlay(overlayEl, me, { mode: 'jev', onSelect: () => {}, onPlay: () => {}, onClose: rec ? closePlay : undefined });
    overlayAction = card.action;
    closeAction = rec ? closePlay : null;
  };
} else {
  let signedOutShown = false;
  let walletShown = false;
  const hooks: TransportHooks = {
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
  };
  const transport = createHttpTransport(hooks);
  // Who steers Pac-Man in the next live game (the demo's own state is a recording).
  let liveControl: 'jev' | 'keyboard' = 'jev';
  const played = () => jevActors(started ? state : ({ pacmanControl: liveControl } as GameState));
  // Which model plays each character: the server default until the player picks, remembered in this browser.
  const defaultModel = me.defaultModel ?? DEFAULT_MODEL;
  // `wanted` is what the player picked; `choice` is what plays. A newly picked model takes over once it is awake, so a
  // cold one doesn't turn the next moves into fallbacks.
  let wanted: ModelChoice = initialChoice(me, loadStoredChoice());
  // "Watch Clef play" on the leaderboard links here with ?pacman=<model>.
  const linked = new URLSearchParams(location.search).get('pacman');
  if (linked && modelOptions(me).some((o) => o.id === linked)) wanted = { ...wanted, pacman: linked };
  let choice: ModelChoice = { ...wanted };
  // The last sign-in or wallet problem a warm-up hit: Play says that, not "didn't wake up".
  let accountProblem: string | null = null;
  const warming = new ModelWarming({
    warmUp: async (m) => {
      const r = await warmUp(m === defaultModel ? undefined : m, hooks);
      accountProblem = !r.ok && r.account ? r.error : null;
      return r.ok;
    },
    now: () => Date.now(),
  });
  const playedModels = () => [...new Set(played().map((id) => wanted[id]))];
  const adopt = () => {
    choice = effectiveChoice(wanted, choice, (m) => warming.isWarm(m), defaultModel);
  };
  /** Warm the models that play now; each takes over as soon as it is awake. */
  const warmPlayed = () => {
    for (const m of playedModels()) {
      void warming.warm(m).then((ok) => {
        if (!ok && started) {
          // The pick never took over: show what is really playing, and say why.
          const stuck = played().filter((id) => wanted[id] === m && choice[id] !== m);
          if (stuck.length) {
            wanted = { ...wanted, ...Object.fromEntries(stuck.map((id) => [id, choice[id]])) };
            saveChoice(wanted);
            panel.syncModels();
            panel.alert(accountProblem ?? `${modelName(m)} didn't wake up; still playing ${modelName(choice[stuck[0]])}. Pick it again to retry.`);
          }
        }
        adopt();
      });
    }
    adopt();
  };
  const picking: ModelPicking = {
    options: modelOptions(me),
    choice: () => wanted,
    onChange: (next) => {
      wanted = next;
      saveChoice(next);
      panel.syncModels();
      if (!started) choice = { ...next }; // Play waits for them
      warmPlayed();
    },
  };
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
        if (e.type === 'call' && e.model) warming.touch(e.model === 'jev-1.13.0' ? DEFAULT_MODEL : e.model);
        panel.handle(e);
        stats.onSchedulerEvent(e);
        // A request still in flight at game over reports afterwards; keep the card's numbers complete.
        if (gameOverShown && !overlayEl.hidden) showGameOver(overlayEl, stats.summary(state), restart);
      },
    });
  let scheduler = newScheduler(stats);
  // The AI plays one side; the other side's characters follow the scripted rules.
  const controls: Controls = {
    decide: (point, s) => (jevActors(s).includes(point.actor) ? scheduler.decide(point, s) : greedyChoice(s, point, optionFeatures(s, point))),
  };
  // No live game runs, and no model is called, until the player presses Play in the card.
  let started = false;
  let gameOverShown = false;
  let playCard: ReturnType<typeof showPlay> | null = null;
  /** The card whose Play is waiting for models to wake; closing that card cancels the start. */
  let waitingFor: ReturnType<typeof showPlay> | null = null;
  /** The card's Play: wake the chosen models first (a few seconds when one has been idle), then start. */
  const play = (): void => {
    const card = playCard;
    if (started || !card || waitingFor === card) return;
    waitingFor = card;
    void warming
      .warmAll(playedModels, (cold) => card.busy(`Waking up ${cold.map(modelName).join(' and ')}…`))
      .then((failed) => {
        if (waitingFor === card) waitingFor = null;
        if (playCard !== card) return; // closed while waking: stay on the demo, start nothing
        card.busy(null);
        if (failed.length) {
          const names = failed.map(modelName).join(' and ');
          return card.note(accountProblem ?? `${names} didn't wake up in time. Press Play to try again, or pick another model.`);
        }
        choice = { ...wanted };
        newGame();
      });
  };
  /** A fresh live game (the first one ends the demo). */
  const newGame = (): void => {
    if (demo) endDemo();
    state = createGame({ pacmanControl: liveControl });
    scheduler.reset();
    stats = new GameStats();
    scheduler = newScheduler(stats);
    panel = new Panel(panelEl, { models: picking });
    panel.enableModelPickers();
    gameOverShown = false;
    paused = false;
    pauseBtn.textContent = 'Pause';
    started = true;
    playCard = null;
    overlayAction = null;
    closeAction = null;
    hideOverlay(overlayEl);
  };

  const setPacmanControl = (control: 'jev' | 'keyboard'): void => {
    liveControl = control;
    if (started) {
      state.pacmanControl = control;
      state.keyDir = null;
    }
    toggleBtn.textContent = `Pac-Man: ${control === 'jev' ? 'AI' : 'you'}`;
    toggleBtn.setAttribute('aria-pressed', String(control === 'jev'));
    playCard?.select(control);
    if (started) warmPlayed();
  };
  const togglePacman = (): void => {
    if (!started && !playCard) return; // J on the demo: nothing to switch yet
    setPacmanControl(liveControl === 'jev' ? 'keyboard' : 'jev');
  };
  let restarting = false;
  /** Restart / Play again (never skips the Play card): wake models that went cold on the game-over screen first. */
  const restart = (): void => {
    if (!started || restarting) return;
    restarting = true;
    void warming.warmAll(playedModels, () => {}).then((failed) => {
      restarting = false;
      if (failed.length) {
        // Stay where we are (the game-over card, or the game) rather than start on a model that isn't there.
        panel.alert(accountProblem ?? `${failed.map(modelName).join(' and ')} didn't wake up, so the game didn't restart. Try again, or pick another model on the cards.`);
        return;
      }
      adopt();
      newGame();
    });
  };
  openPlay = () => {
    if (started || playCard) return;
    playCta.hidden = true;
    playCard = showPlay(overlayEl, me, {
      mode: liveControl,
      onSelect: setPacmanControl,
      onPlay: () => play(),
      models: picking,
      onClose: demo ? () => ((playCard = null), closePlay()) : undefined,
    });
    overlayAction = playCard.action;
    closeAction = demo ? () => ((playCard = null), closePlay()) : null;
  };
  toggleBtn.addEventListener('click', togglePacman);
  restartBtn.addEventListener('click', restart);
  speedIn.addEventListener('input', () => {
    speed = Number(speedIn.value);
    speedOut.textContent = `${speed.toFixed(2)}×`;
  });
  keyActions.set('j', togglePacman).set('r', restart);
  steer = (dir) => {
    if (started) state.keyDir = dir;
  };
  const liveTick = (dt: number) => {
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
  const demoTick = (dt: number) => {
    for (const e of demo!.advance(dt)) panel.handle(e);
    state = demo!.state;
  };
  // One tick for both phases: the demo until the first live game, then the live game.
  tick = (dt) => (started ? liveTick(dt) : demo ? demoTick(dt) : undefined);
}

playCta.addEventListener('click', () => openPlay());
if (rec) {
  const both = tick;
  startDemo(rec);
  if (me.mode !== 'none') tick = both; // signed in, one tick plays the demo until a live game starts
  overlayAction = openPlay;
  // From "Watch Clef play" on the leaderboard: straight to the Play card, with that model picked.
  if (new URLSearchParams(location.search).has('pacman')) openPlay();
} else {
  // No recording to show: open the card straight away, as before.
  for (const control of LIVE_CONTROLS) control.disabled = me.mode === 'none';
  openPlay();
}
showAccount({ ...account, notice: accountNotice(me, authError, me.mode === 'none' && Boolean(rec)) });

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
  if (e.key === 'Escape' && closeAction) {
    closeAction();
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
