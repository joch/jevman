import './style.css';
import { accountNotice, fetchMe, renderAccount, takeAuthError, walletNotice, type AccountView } from './auth';
import { DemoPlayer, loadRecording } from './demo';
import { hideOverlay, isClassic, showGameOver, showPlay, type GameOverExtra, type Sides } from './overlay';
import { shareText, versus, versusLine } from './versus';
import type { Leaderboard } from '../shared/leaderboard';
import { Panel } from './panel';
import { drawGame, FRUIT_EMOJI, TILE } from './render';
import { greedyChoice, optionFeatures } from './features';
import { Scheduler } from './scheduler';
import { createGame, fruitForLevel, jevActors, step, type Controls, type GameState } from './sim';
import { GameStats } from './stats';
import { createHttpTransport, warmUp, type TransportHooks } from './transport';
import { attachTouch } from './touch';
import { cuesBetween, snapshot, Sound } from './sound';
import { Thinking } from './thinking';
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
/** The models' odds drawn on the board at each junction. */
const thinking = new Thinking();
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
const muteBtn = $<HTMLButtonElement>('#mute');
const sound = new Sound();
const showSound = () => {
  muteBtn.textContent = sound.enabled ? '🔊' : '🔇';
  muteBtn.setAttribute('aria-pressed', String(!sound.enabled));
  muteBtn.title = sound.enabled ? 'Mute (M)' : 'Unmute (M)';
};
showSound();
const toggleSound = () => {
  sound.toggle();
  sound.unlock();
  showSound();
};
muteBtn.addEventListener('click', toggleSound);
// Browsers allow audio only after a gesture; any click or key unlocks it.
// (iOS only counts the end of a tap as a gesture, hence pointerup/touchend/click as well as pointerdown.)
for (const ev of ['pointerdown', 'pointerup', 'touchend', 'click', 'keydown'] as const) window.addEventListener(ev, () => sound.unlock(), { passive: true });
const dpad = $('#dpad');
const boardEl = $('.board');
/** The on-screen pad shows on touch screens while the player steers Pac-Man. */
const touchScreen = matchMedia('(pointer: coarse)').matches;
const help = $('.help');
const hud = { score: $('#score'), level: $('#level'), lives: $('#lives'), fruit: $('#fruit-hud') };

/** Set by a live game: wakes the models that play (they doze off during a long pause); false keeps the game paused. */
let beforeResume: (() => Promise<boolean>) | null = null;
let resuming = false;
/** Which live game is running; a slow callback (Resume, Play again, a side switch) from an older one does nothing. */
let gameId = 0;
function togglePause(): void {
  if (!overlayEl.hidden || resuming) return; // nothing is running behind the Play / game-over card
  if (paused && beforeResume) {
    resuming = true;
    pauseBtn.textContent = 'Waking up…';
    const id = gameId;
    void beforeResume().then((ok) => {
      if (id !== gameId) return; // that game was restarted meanwhile
      resuming = false;
      paused = !ok || document.hidden;
      pauseBtn.textContent = paused ? 'Resume' : 'Pause';
    });
    return;
  }
  paused = !paused;
  pauseBtn.textContent = paused ? 'Resume' : 'Pause';
}
pauseBtn.addEventListener('click', togglePause);

const overlayEl = $('#overlay');
const keyActions = new Map<string, () => void>([['p', togglePause], ['m', toggleSound]]);
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
  // Controls that only mean something in a live game stay out of the way until one starts.
  for (const control of LIVE_CONTROLS) (control.closest('label') ?? control).hidden = true;
  help.textContent = 'Recorded game · press Play (or Space) to play live';
  playCta.hidden = false;
  tick = (dt) => {
    for (const e of demo!.advance(dt)) {
      panel.handle(e);
      if (e.type === 'decision') thinking.add(e.decision, performance.now());
    }
    state = demo!.state;
  };
}
function endDemo(): void {
  demo = null;
  for (const control of LIVE_CONTROLS) (control.closest('label') ?? control).hidden = false;
  help.textContent = 'Arrows/WASD or swipe steer when you play Pac-Man · J: Pac-Man to the AI or back · P pause · R restart';
  playCta.hidden = true;
}

// The leaderboard, to compare a game with (loaded in the background; a game over before it arrives just skips it).
let board: Leaderboard | null = null;
const boardLoaded = fetch('/leaderboard.json')
  .then((r) => (r.ok ? (r.json() as Promise<Leaderboard>) : null))
  .then((b) => void (board = b))
  .catch(() => {});
const SHARE_URL = 'https://jevman.apps.chadda.se';
const BEST_KEY = 'jevman.best';
const readBest = (): number => {
  try {
    return Number(localStorage.getItem(BEST_KEY)) || 0;
  } catch {
    return 0;
  }
};
const writeBest = (score: number) => {
  try {
    localStorage.setItem(BEST_KEY, String(score));
  } catch {
    // not remembered
  }
};
/** The system share sheet on phones (where people share from), else the clipboard. */
async function shareScore(text: string): Promise<'shared' | 'copied' | 'failed' | 'cancelled'> {
  if (navigator.share && touchScreen) {
    try {
      await navigator.share({ text });
      return 'shared';
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') return 'cancelled'; // the player closed the sheet
    }
  }
  try {
    await navigator.clipboard.writeText(text);
    return 'copied';
  } catch {
    return 'failed';
  }
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
  // From "Watch Clef play" while signed out: remember the pick through the sign-in round trip (it is checked against
  // the models the key can use once signed in).
  const linked = new URLSearchParams(location.search).get('pacman');
  if (linked) {
    const stored = loadStoredChoice();
    saveChoice({ ...(stored && typeof stored === 'object' ? stored : {}), pacman: linked } as ModelChoice);
  }
}
// The live game, for everyone: signed out it is the classic game only (the player against the scripted ghosts, no AI).
{
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
  const canUseAI = me.mode !== 'none';
  let liveMode: Sides = canUseAI ? { pacman: 'ai', ghosts: 'classic' } : { pacman: 'you', ghosts: 'classic' };
  const sides = (m: Sides) => ({ pacmanControl: m.pacman === 'ai' ? ('jev' as const) : ('keyboard' as const), ghostsByAI: m.ghosts === 'ai' });
  const played = () => jevActors(started ? state : sides(liveMode));
  /** Whether this game has been the classic game from the start, so its score compares with the leaderboard. */
  let classicThroughout = false;
  /** Whether the AI has played Pac-Man the whole game, on one model, so it compares with that model's average. */
  let aiPacmanThroughout: string | null = null;
  let gameOverExtra: GameOverExtra = {};
  /** Whether the speed slider was below 1× at any point this game: the leaderboard ran at full speed. */
  let slowed = false;
  /** The game-over extras: you against the AIs (classic game), or the AI against its leaderboard average. */
  const resultOf = (score: number): GameOverExtra => {
    if (slowed && (classicThroughout || aiPacmanThroughout !== null)) {
      return { aiNote: 'Played below full speed, so this game is not compared with the leaderboard (the AIs played at 1×).' };
    }
    if (classicThroughout) {
      const best = readBest();
      const newBest = score > best;
      if (newBest) writeBest(score);
      if (!board?.entries.length) return { newBest, best };
      const v = versus(board, score);
      const text = shareText(v, SHARE_URL);
      return { newBest, best, versus: versusLine(v), share: () => shareScore(text) };
    }
    const entry = aiPacmanThroughout ? board?.entries.find((e) => e.model === aiPacmanThroughout) : undefined;
    if (entry) {
      return {
        aiNote: `${entry.name} scored ${score.toLocaleString('en-US')} this game; its leaderboard average is ${entry.meanScore.toLocaleString('en-US')}.`,
      };
    }
    return {};
  };
  // Which model plays each character: the server default until the player picks, remembered in this browser.
  const defaultModel = me.defaultModel ?? DEFAULT_MODEL;
  // `wanted` is what the player picked; `choice` is what plays. A newly picked model takes over once it is awake, so a
  // cold one doesn't turn the next moves into fallbacks.
  let wanted: ModelChoice = initialChoice(me, loadStoredChoice());
  // "Watch Clef play" on the leaderboard links here with ?pacman=<model>.
  const linked = new URLSearchParams(location.search).get('pacman');
  if (linked && modelOptions(me).some((o) => o.id === linked)) wanted = { ...wanted, pacman: linked };
  let choice: ModelChoice = { ...wanted };
  // A model's last permanent warm-up refusal (signed out, wallet, not enabled): Play says that, not "didn't wake up".
  // Per model: concurrent warm-ups must not overwrite each other's answer.
  const warmProblems = new Map<string, string>();
  const problemOf = (models: string[]) => models.map((m) => warmProblems.get(m)).find((p) => p !== undefined);
  const warming = new ModelWarming({
    warmUp: async (m) => {
      const r = await warmUp(m === defaultModel ? undefined : m, hooks);
      // A refusal holds until the model actually answers (a later timeout doesn't make it less true).
      if (r.ok) warmProblems.delete(m);
      else if (r.account) warmProblems.set(m, r.error);
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
        if (ok) panel.clearAlert(`model:${m}`); // that model's retry worked: its "still playing …" note no longer holds
        if (!ok && started) {
          // The pick never took over: show what is really playing, and say why.
          const stuck = played().filter((id) => wanted[id] === m && choice[id] !== m);
          if (stuck.length) {
            wanted = { ...wanted, ...Object.fromEntries(stuck.map((id) => [id, choice[id]])) };
            saveChoice(wanted);
            panel.syncModels();
            panel.alert(problemOf([m]) ?? `${modelName(m)} didn't wake up; still playing ${modelName(choice[stuck[0]])}. Pick it again to retry.`, `model:${m}`);
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
      if (started && next.pacman !== wanted.pacman) aiPacmanThroughout = null;
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
        if (e.type === 'decision') thinking.add(e.decision, performance.now());
        stats.onSchedulerEvent(e);
        // A request still in flight at game over reports afterwards; keep the card's numbers complete.
        if (gameOverShown && !overlayEl.hidden) showGameOver(overlayEl, stats.summary(state), playAgain, gameOverExtra);
      },
    });
  let scheduler = newScheduler(stats);
  // The sides the AI doesn't play follow the scripted rules.
  const controls: Controls = {
    decide: (point, s) => (jevActors(s).includes(point.actor) ? scheduler.decide(point, s) : greedyChoice(s, point, optionFeatures(s, point))),
  };
  // No live game runs until the player presses Play in the card. Picking a model there does send its warm-up (one
  // tiny call, about $0.000001) right away, so it is likely awake by the time Play is pressed.
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
          return card.note(problemOf(failed) ?? `${names} didn't wake up in time. Press Play to try again, or pick another model.`);
        }
        choice = { ...wanted };
        newGame();
      });
  };
  /** A fresh live game (the first one ends the demo). */
  /** Ends whatever was pending for the game before (a J switch, Resume, Play again): their callbacks now do nothing. */
  const retireGame = (): void => {
    gameId += 1;
    switching = false;
    resuming = false;
    restarting = false;
  };
  const newGame = (): void => {
    retireGame();
    if (demo) endDemo();
    if (!canUseAI) {
      toggleBtn.disabled = true; // the classic game only, until signing in
      toggleBtn.title = 'Sign in with Opper to watch the AI or face AI ghosts';
      help.textContent = 'Arrows/WASD or swipe steer · P pause · R restart · M sound';
      if (account.kind === 'demo' || account.kind === 'signed-out') showAccount({ kind: 'free', me });
    }
    if (!switching) showToggle(liveMode);
    state = createGame(sides(liveMode));
    thinking.clear();
    slowed = speed < 1;
    classicThroughout = isClassic(liveMode);
    // Only against the classic ghosts does the AI's score compare with its leaderboard average.
    aiPacmanThroughout = liveMode.pacman === 'ai' && liveMode.ghosts === 'classic' ? choice.pacman : null;
    sound.play('start');
    gameOverExtra = {};
    scheduler.reset();
    stats = new GameStats();
    scheduler = newScheduler(stats);
    panel = new Panel(panelEl, { models: picking });
    panel.enableModelPickers();
    gameOverShown = false;
    // A game that finished waking while the tab was hidden starts paused (Resume then re-checks the models).
    paused = document.hidden;
    pauseBtn.textContent = paused ? 'Resume' : 'Pause';
    started = true;
    playCard = null;
    overlayAction = null;
    closeAction = null;
    hideOverlay(overlayEl);
  };

  let switching = false;
  const showToggle = (m: Sides) => {
    toggleBtn.textContent = `Pac-Man: ${m.pacman === 'ai' ? 'AI' : 'you'}`;
    toggleBtn.setAttribute('aria-pressed', String(m.pacman === 'ai'));
  };
  const setMode = (mode: Sides): void => {
    if (switching || (!canUseAI && !isClassic(mode))) return;
    const apply = () => {
      if (mode.pacman !== liveMode.pacman || mode.ghosts !== liveMode.ghosts) {
        classicThroughout = false;
        aiPacmanThroughout = null;
      }
      liveMode = mode;
      if (started) {
        Object.assign(state, sides(mode));
        state.keyDir = null;
        panel.clearAlert('switch');
      }
      showToggle(mode);
      playCard?.select(mode);
      if (started) warmPlayed();
    };
    if (!started) return apply();
    // Mid-game: the side that takes over keeps waiting for its models; the current side plays on meanwhile.
    const incoming = [...new Set(jevActors(sides(mode)).map((id) => wanted[id]))];
    if (incoming.every((m) => warming.isWarm(m))) return apply();
    switching = true;
    toggleBtn.textContent = 'Waking up…';
    const id = gameId;
    void warming.warmAll(() => incoming, () => {}).then((failed) => {
      if (id !== gameId) return; // Restart cancelled this switch
      switching = false;
      if (failed.length) {
        // The current side plays on; say why the switch didn't happen.
        showToggle(liveMode);
        panel.alert(problemOf(failed) ?? `${failed.map(modelName).join(' and ')} didn't wake up, so the sides didn't switch. Press J to try again.`, 'switch');
        return;
      }
      adopt();
      apply();
    });
  };
  const togglePacman = (): void => {
    if (!canUseAI || (!started && !playCard)) return; // signed out (classic only), or J on the demo
    // J hands Pac-Man to the AI or takes him back; the ghosts stay as they are.
    setMode({ ...liveMode, pacman: liveMode.pacman === 'ai' ? 'you' : 'ai' });
  };
  let restarting = false;
  /** Play again on the game-over card: the same game again, waking models that went cold on that card first. */
  const playAgain = (): void => {
    if (!started || restarting) return;
    restarting = true;
    const id = gameId;
    void warming.warmAll(playedModels, () => {}).then((failed) => {
      if (id !== gameId) return; // Restart (and maybe another game) came first; their flags are their own
      restarting = false;
      if (failed.length) {
        // Stay where we are (the game-over card, or the game) rather than start on a model that isn't there.
        panel.alert(problemOf(failed) ?? `${failed.map(modelName).join(' and ')} didn't wake up, so the game didn't restart. Try again, or pick another model on the cards.`, 'restart');
        return;
      }
      adopt();
      newGame();
    });
  };
  /** Restart (the button, R): end this game and pick what to play next in the Play card. */
  const restart = (): void => {
    // Restart wins over a Play again or a J switch still waking models: both check for it when they finish.
    if (!started) return;
    retireGame();
    showToggle(liveMode);
    started = false; // nothing runs (or is billed) behind the card
    paused = false;
    // Retire the old game: answers still in flight reach its scheduler and stats, not the card.
    gameOverShown = false;
    scheduler.reset();
    stats = new GameStats();
    scheduler = newScheduler(stats);
    pauseBtn.textContent = 'Pause';
    openPlay();
  };
  openPlay = () => {
    if (started || playCard) return;
    playCta.hidden = true;
    playCard = showPlay(overlayEl, me, {
      sides: liveMode,
      onSelect: setMode,
      onPlay: () => play(),
      models: picking,
      averages: () => board?.entries,
      onClose: demo ? () => ((playCard = null), closePlay()) : undefined,
    });
    overlayAction = playCard.action;
    closeAction = demo ? () => ((playCard = null), closePlay()) : null;
  };
  // A card opened before the leaderboard arrived (a ?pacman= link) shows the model's average once it does.
  void boardLoaded.then(() => playCard?.select(liveMode));
  toggleBtn.addEventListener('click', togglePacman);
  restartBtn.addEventListener('click', restart);
  speedIn.addEventListener('input', () => {
    speed = Number(speedIn.value);
    speedOut.textContent = `${speed.toFixed(2)}×`;
    if (speed < 1) slowed = true;
  });
  keyActions.set('j', togglePacman).set('r', restart);
  // A hidden tab pauses a live game (and the browser stops the clock anyway); resuming wakes the models first.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && started && !paused && overlayEl.hidden) {
      paused = true;
      pauseBtn.textContent = 'Resume';
    }
  });
  beforeResume = async () => {
    if (!started) return true;
    const id = gameId;
    const failed = await warming.warmAll(playedModels, () => {});
    if (id !== gameId) return false; // restarted meanwhile: nothing here is about the new game
    if (failed.length) {
      panel.alert(problemOf(failed) ?? `${failed.map(modelName).join(' and ')} didn't wake up, so the game stays paused. Press Resume to try again.`, 'resume');
      return false;
    }
    panel.clearAlert('resume');
    adopt();
    return true;
  };
  steer = (dir) => {
    if (started) state.keyDir = dir;
  };
  attachTouch($('.board'), dpad, (dir) => steer?.(dir), () => started && state.pacmanControl === 'keyboard' && overlayEl.hidden === true);
  const liveTick = (dt: number) => {
    clockMs += dt * 1000;
    scheduler.update(state);
    stats.beforeStep(state);
    const heard = snapshot(state);
    step(state, dt * speed, controls);
    stats.afterStep(state, dt * speed);
    for (const cue of cuesBetween(heard, state)) sound.play(cue);
    if (state.status === 'gameover' && !gameOverShown) {
      gameOverShown = true;
      overlayAction = playAgain;
      gameOverExtra = resultOf(state.score);
      showGameOver(overlayEl, stats.summary(state), playAgain, gameOverExtra);
    }
  };
  const demoTick = (dt: number) => {
    for (const e of demo!.advance(dt)) {
      panel.handle(e);
      if (e.type === 'decision') thinking.add(e.decision, performance.now());
    }
    state = demo!.state;
  };
  // One tick for both phases: the demo until the first live game, then the live game.
  tick = (dt) => (started ? liveTick(dt) : demo ? demoTick(dt) : undefined);
}

playCta.addEventListener('click', () => openPlay());
if (rec) {
  const both = tick;
  startDemo(rec);
  tick = both; // one tick plays the demo until a live game starts
  overlayAction = openPlay;
  // From "Watch Clef play" on the leaderboard: straight to the Play card, with that model picked.
  if (new URLSearchParams(location.search).has('pacman')) openPlay();
} else {
  // No recording to show: open the card straight away, as before.
  for (const control of LIVE_CONTROLS) control.disabled = false;
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
  if (state.status === 'playing') thinking.draw(ctx, now);
  const steering = !demo && state.pacmanControl === 'keyboard' && overlayEl.hidden === true;
  const showPad = touchScreen && steering;
  if (dpad.hidden === showPad) dpad.hidden = !showPad;
  boardEl.classList.toggle('steering', steering);
  panel.updateActors(state);
  updateHud();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
