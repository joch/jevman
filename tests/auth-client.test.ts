import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchMe } from '../src/auth';

const WALLET = 'https://platform.opper.ai/wallet';

function stub(impl: () => Promise<Response>) {
  const f = vi.fn(impl);
  vi.stubGlobal('fetch', f);
  return f;
}
const reply = (body: unknown, status = 200) => stub(async () => new Response(JSON.stringify(body), { status }));

afterEach(() => vi.unstubAllGlobals());

describe('fetchMe', () => {
  const fallback = { mode: 'none', walletUrl: WALLET, loginAvailable: true, unavailable: true };

  it('falls back (sign-in still enabled) on a network error', async () => {
    stub(async () => {
      throw new TypeError('fetch failed');
    });
    await expect(fetchMe()).resolves.toEqual(fallback);
  });

  it('falls back on a timeout', async () => {
    stub(async () => {
      throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    });
    await expect(fetchMe()).resolves.toEqual(fallback);
  });

  it('falls back on a non-OK response', async () => {
    reply({ mode: 'player', walletUrl: WALLET, loginAvailable: true }, 500);
    await expect(fetchMe()).resolves.toEqual(fallback);
  });

  it('falls back on bad JSON', async () => {
    stub(async () => new Response('<html>', { status: 200 }));
    await expect(fetchMe()).resolves.toEqual(fallback);
  });

  it('falls back on an invalid shape', async () => {
    for (const body of [null, 'player', 42, [], {}, { mode: 'admin' }]) {
      reply(body);
      await expect(fetchMe()).resolves.toEqual(fallback);
    }
  });

  it('replaces a non-https walletUrl with the default', async () => {
    for (const walletUrl of ['http://evil.example/wallet', 'javascript:alert(1)', 'not a url', 7, undefined]) {
      reply({ mode: 'player', walletUrl, loginAvailable: true, user: { name: 'Ada' } });
      expect((await fetchMe()).walletUrl).toBe(WALLET);
    }
  });

  it('treats empty user name and email as missing', async () => {
    reply({ mode: 'player', walletUrl: WALLET, loginAvailable: true, user: { name: '', email: '' } });
    const me = await fetchMe();
    expect(me.user?.name).toBeUndefined();
    expect(me.user?.email).toBeUndefined();
  });

  it('returns a valid response and asks with a timeout signal', async () => {
    const body = { mode: 'player', user: { name: 'Ada', email: 'ada@example.com' }, projectName: 'jevman', walletUrl: 'https://platform.opper.ai/w', loginAvailable: true };
    const f = reply(body);
    await expect(fetchMe()).resolves.toEqual(body);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/me');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});
