import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, type App } from '../server/app';

const SECRET = 's'.repeat(64);
let dist: string;
let app: App | undefined;
const events: { event: string; [k: string]: unknown }[] = [];

function makeDist(): string {
  const dir = mkdtempSync(join(tmpdir(), 'jevman-dist-'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>jevman</title>');
  writeFileSync(join(dir, 'leaderboard.html'), '<!doctype html><title>Which AI plays Pac-Man best?</title>');
  writeFileSync(join(dir, 'leaderboard.json'), '{"entries":[]}');
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'assets', 'index-abc123.js'), 'console.log(1)');
  mkdirSync(join(dir, 'demo'));
  writeFileSync(join(dir, 'demo', 'jev-demo.json'), '{"version":1}');
  return dir;
}

async function start(env: Record<string, string> = {}, opts: { drainMs?: number; deadlineMs?: number } = {}) {
  dist = makeDist();
  events.length = 0;
  app = createApp({
    env: { SESSION_SECRET: SECRET, ...env },
    distDir: dist,
    commit: 'a'.repeat(40),
    log: (event, details = {}) => events.push({ event, ...details }),
    drainMs: opts.drainMs ?? 50,
    deadlineMs: opts.deadlineMs ?? 2000,
  });
  const port = await app.listen(0);
  return `http://127.0.0.1:${port}`;
}

afterEach(async () => {
  await app?.close();
  app = undefined;
  rmSync(dist, { recursive: true, force: true });
});

describe('production server', () => {
  it('reports readiness and the deployed commit', async () => {
    const url = await start();
    const health = await fetch(`${url}/health`);
    expect(health.status).toBe(200);
    expect(health.headers.get('cache-control')).toBe('no-store');
    expect(await (await fetch(`${url}/revision`)).json()).toEqual({ app: 'jevman', commit: 'a'.repeat(40), draining: false });
  });

  it('serves the built page, hashed assets and the demo with sensible caching and security headers', async () => {
    const url = await start();
    const page = await fetch(`${url}/`);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(page.headers.get('cache-control')).toBe('no-cache');
    expect(page.headers.get('x-content-type-options')).toBe('nosniff');
    expect(page.headers.get('x-frame-options')).toBe('DENY');
    expect(await page.text()).toContain('jevman');
    const asset = await fetch(`${url}/assets/index-abc123.js`);
    expect(asset.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(asset.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    const demo = await fetch(`${url}/demo/jev-demo.json`);
    expect(demo.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(await demo.json()).toEqual({ version: 1 });
  });

  it('serves the leaderboard page at a clean URL, and its results', async () => {
    const url = await start();
    const page = await fetch(`${url}/leaderboard`);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(await page.text()).toContain('Which AI plays Pac-Man best?');
    expect(await (await fetch(`${url}/leaderboard.json`)).json()).toEqual({ entries: [] });
    expect((await fetch(`${url}/nothing-here`)).status).toBe(404);
  });

  it('refuses paths outside the build and unknown files', async () => {
    const url = await start();
    expect((await fetch(`${url}/nope.js`)).status).toBe(404);
    expect((await fetch(`${url}/%2e%2e/%2e%2e/etc/passwd`)).status).toBe(404);
    expect((await fetch(`${url}/assets/..%2f..%2fpackage.json`)).status).toBe(404);
    expect((await fetch(`${url}/`, { method: 'POST' })).status).toBe(405);
  });

  it('mounts the jev and auth routes', async () => {
    const url = await start({ OPPER_CLIENT_ID: 'opper_app_x', OPPER_CLIENT_SECRET: 'shh' });
    expect(await (await fetch(`${url}/api/me`)).json()).toMatchObject({ mode: 'none', loginAvailable: true });
    const decide = await fetch(`${url}/api/decide`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect(decide.status).toBe(401);
    const login = await fetch(`${url}/auth/login`, { redirect: 'manual' });
    expect(login.status).toBe(302);
  });

  it('refuses to start an https deployment without a real session secret', () => {
    dist = makeDist();
    expect(() => createApp({ env: { OPPER_REDIRECT_URI: 'https://jevman.example/auth/callback' }, distDir: dist, commit: 'x' })).toThrow(/SESSION_SECRET/);
  });

  it('drains on shutdown: health fails at once, requests are still served, then the listener closes', async () => {
    const url = await start({}, { drainMs: 300 });
    const done = app!.shutdown();
    const health = await fetch(`${url}/health`);
    expect(health.status).toBe(503);
    expect(await (await fetch(`${url}/revision`)).json()).toMatchObject({ draining: true });
    expect((await fetch(`${url}/`)).status).toBe(200);
    expect(await done).toBe('clean');
    await expect(fetch(`${url}/health`)).rejects.toThrow();
    expect(events.map((e) => e.event)).toEqual(expect.arrayContaining(['listening', 'ready', 'draining', 'listener-close', 'shutdown-complete']));
  });

  it('logs structured events without secrets', async () => {
    const url = await start({ OPPER_CLIENT_ID: 'opper_app_x', OPPER_CLIENT_SECRET: 'shh-secret' });
    await fetch(`${url}/auth/callback?code=c&state=x`, { redirect: 'manual' });
    expect(JSON.stringify(events)).not.toContain('shh-secret');
    expect(JSON.stringify(events)).not.toContain(SECRET);
    expect(events[0]).toMatchObject({ event: 'listening' });
  });
});
