import type { GameState } from './sim';

/** What happened in one step of the game that deserves a sound ('start' is played when a new game begins). */
export type SoundCue = 'pellet' | 'power' | 'ghost' | 'fruit' | 'death' | 'levelclear' | 'start';

const GHOST_POINTS = new Set(['200', '400', '800', '1600']);

/** A snapshot of what `cuesBetween` compares, taken before a step. */
export interface SoundSnapshot {
  status: GameState['status'];
  pelletsEaten: number;
  frightLeft: number;
  popups: Set<GameState['popups'][number]>;
  level: number;
}

export const snapshot = (s: GameState): SoundSnapshot => ({
  status: s.status,
  pelletsEaten: s.pelletsEaten,
  frightLeft: s.frightLeft,
  popups: new Set(s.popups),
  level: s.level,
});

/** The sounds one step calls for, from the state before and after it. */
export function cuesBetween(before: SoundSnapshot, after: GameState): SoundCue[] {
  const cues: SoundCue[] = [];
  if (after.frightLeft > before.frightLeft + 0.5) cues.push('power');
  else if (after.pelletsEaten > before.pelletsEaten) cues.push('pellet');
  for (const p of after.popups) {
    if (before.popups.has(p)) continue;
    cues.push(GHOST_POINTS.has(p.text) ? 'ghost' : 'fruit');
  }
  if (before.status === 'playing' && after.status === 'dying') cues.push('death');
  if (before.status === 'playing' && after.status === 'levelclear') cues.push('levelclear');
  return cues;
}

const STORAGE_KEY = 'jevman.sound';

/** Synthesized arcade sounds (WebAudio, no files). Starts on the first user gesture; muting is remembered. */
export class Sound {
  private ctx: AudioContext | null = null;
  private waka = false;
  private lastPellet = 0;
  enabled: boolean;

  constructor() {
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(STORAGE_KEY);
    } catch {
      // storage blocked: sound on, not remembered
    }
    this.enabled = stored !== 'off';
  }

  /** Call from a click or key press: browsers only allow audio after one. */
  unlock(): void {
    if (this.ctx) return void this.ctx.resume().catch(() => {});
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    this.ctx = new Ctx();
  }

  toggle(): boolean {
    this.enabled = !this.enabled;
    try {
      localStorage.setItem(STORAGE_KEY, this.enabled ? 'on' : 'off');
    } catch {
      // not remembered
    }
    return this.enabled;
  }

  play(cue: SoundCue): void {
    if (!this.enabled || !this.ctx || this.ctx.state !== 'running') return;
    const now = this.ctx.currentTime;
    switch (cue) {
      case 'pellet': {
        if (now - this.lastPellet < 0.09) return; // a run of pellets sounds like one waka-waka, not a buzz
        this.lastPellet = now;
        this.waka = !this.waka;
        return this.sweep(this.waka ? 260 : 520, this.waka ? 520 : 260, 0.09, 'triangle', 0.18);
      }
      case 'power':
        return this.sweep(180, 90, 0.35, 'sawtooth', 0.12);
      case 'ghost':
        return this.sweep(300, 1400, 0.22, 'square', 0.1);
      case 'fruit':
        return this.notes([880, 1175, 1568], 0.07, 'triangle', 0.16);
      case 'death':
        return this.sweep(700, 80, 1.1, 'square', 0.1);
      case 'levelclear':
        return this.notes([523, 659, 784, 1047, 784, 1047], 0.1, 'triangle', 0.16);
      case 'start':
        return this.notes([494, 988, 740, 622, 988, 740, 622], 0.11, 'square', 0.08);
    }
  }

  private sweep(from: number, to: number, seconds: number, type: OscillatorType, volume: number, at = 0): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime + at;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(from, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, to), t + seconds);
    gain.gain.setValueAtTime(volume, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + seconds);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + seconds + 0.02);
  }

  private notes(freqs: number[], each: number, type: OscillatorType, volume: number): void {
    freqs.forEach((f, i) => this.sweep(f, f, each * 0.95, type, volume, i * each));
  }
}
