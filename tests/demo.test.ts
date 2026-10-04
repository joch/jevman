import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEMO_LOOP_PAUSE_S, DemoPlayer, loadRecording } from '../src/demo';
import { Replay, type Recording } from '../src/replay';
import { recordGreedy } from './support/greedy-recording';

const DT = 1 / 64; // exact in binary, so frame boundaries are exact
const withEvents = (frames: number): Recording => ({
  ...recordGreedy(frames, () => DT),
  events: Array.from({ length: frames }, (_, f) => [f, { type: 'error', message: `frame ${f}` }] as Recording['events'][number]),
});

describe('DemoPlayer', () => {
  it('consumes as many recorded frames as the elapsed time covers, with all their events', () => {
    const demo = new DemoPlayer(withEvents(10));
    expect(demo.advance(DT / 2)).toEqual([]);
    expect(demo.frame).toBe(0);
    expect(demo.advance(DT / 2 + 2 * DT).map((e) => (e as { message: string }).message)).toEqual(['frame 0', 'frame 1', 'frame 2']);
    expect(demo.frame).toBe(3);
  });

  it('plays the same game as stepping the replay frame by frame', () => {
    const rec = recordGreedy(300);
    const demo = new DemoPlayer(rec);
    for (let i = 0; i < 400 && !demo.done; i++) demo.advance(0.05);
    const replay = new Replay(rec);
    while (!replay.done) replay.stepFrame();
    expect(demo.done).toBe(true);
    expect(JSON.stringify(demo.state)).toBe(JSON.stringify(replay.state));
  });

  it('does not move unless advanced (pausing the caller pauses the demo)', () => {
    const demo = new DemoPlayer(withEvents(10));
    demo.advance(3 * DT);
    const before = JSON.stringify(demo.state);
    expect(demo.frame).toBe(3);
    expect(JSON.stringify(demo.state)).toBe(before);
  });

  it(`starts over ${DEMO_LOOP_PAUSE_S} s of demo time after the game ends, telling the caller`, () => {
    const onLoop = vi.fn();
    const demo = new DemoPlayer(withEvents(4), { onLoop });
    demo.advance(4 * DT);
    expect(demo.done).toBe(true);
    const ended = demo.state;
    // Wall-clock gaps don't count: only the time handed to advance does.
    expect(demo.advance(1)).toEqual([]);
    expect(demo.advance(DEMO_LOOP_PAUSE_S - 1.01)).toEqual([]);
    expect(onLoop).not.toHaveBeenCalled();
    expect(demo.state).toBe(ended);
    expect(demo.advance(0.02)).toEqual([]);
    expect(onLoop).toHaveBeenCalledOnce();
    expect(demo.loops).toBe(1);
    expect(demo.state).not.toBe(ended);
    expect(demo.frame).toBe(0);
    expect(demo.advance(DT).map((e) => (e as { message: string }).message)).toEqual(['frame 0']);
  });
});

describe('loadRecording', () => {
  afterEach(() => vi.unstubAllGlobals());
  const good = recordGreedy(5);
  const reply = (body: unknown, status = 200) => vi.stubGlobal('fetch', vi.fn(async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })));

  it('returns a valid recording and asks with a timeout signal', async () => {
    const f = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(good)));
    vi.stubGlobal('fetch', f);
    await expect(loadRecording('/demo/x.json')).resolves.toEqual(good);
    expect(f.mock.calls[0][0]).toBe('/demo/x.json');
    expect(f.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    ['version 2', { ...good, version: 2 }],
    ['no frames', { ...good, frames: undefined }],
    ['frames not an array', { ...good, frames: {} }],
    ['decisions not an array', { ...good, decisions: 'x' }],
    ['events not an array', { ...good, events: null }],
    ['no final', { ...good, final: undefined }],
    ['null', null],
    ['an array', []],
  ])('returns null for %s', async (_name, body) => {
    reply(body);
    await expect(loadRecording('/demo/x.json')).resolves.toBeNull();
  });

  it('returns null for a non-OK response, bad JSON or a network error', async () => {
    reply(good, 404);
    await expect(loadRecording('/demo/x.json')).resolves.toBeNull();
    reply('<html>');
    await expect(loadRecording('/demo/x.json')).resolves.toBeNull();
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('fetch failed');
    }));
    await expect(loadRecording('/demo/x.json')).resolves.toBeNull();
  });

  it('returns null when the download takes longer than the timeout', async () => {
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(init.signal!.reason));
    })));
    await expect(loadRecording('/demo/x.json', 20)).resolves.toBeNull();
  });
});
