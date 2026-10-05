import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHttpTransport, httpTransport } from '../src/transport';
import type { SystemOneRequest } from '../src/brain';

const req = { state: {}, questions: {} } as unknown as SystemOneRequest;
const good = { answers: { blinky: {} }, usage: { input_tokens: 1, output_tokens: 1 }, latencyMs: 10, costUsd: 0, traceId: 't' };

function stub(impl: () => Promise<Response>) {
  const f = vi.fn(impl);
  vi.stubGlobal('fetch', f);
  return f;
}

afterEach(() => vi.unstubAllGlobals());

describe('httpTransport', () => {
  it('posts to /api/decide and returns the parsed response', async () => {
    const f = stub(async () => new Response(JSON.stringify(good), { status: 200 }));
    await expect(httpTransport(req)).resolves.toEqual(good);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/decide');
    expect(init.method).toBe('POST');
  });

  it('throws the server error message for a non-ok response', async () => {
    stub(async () => new Response(JSON.stringify({ error: 'jev 1.13 timed out after 2000 ms' }), { status: 504 }));
    await expect(httpTransport(req)).rejects.toThrow('jev 1.13 timed out after 2000 ms');
  });

  it('throws when an ok response has an invalid body', async () => {
    stub(async () => new Response('not json', { status: 200 }));
    await expect(httpTransport(req)).rejects.toThrow('/api/decide returned an invalid response');
    stub(async () => new Response(JSON.stringify({ answers: {} }), { status: 200 }));
    await expect(httpTransport(req)).rejects.toThrow('/api/decide returned an invalid response');
  });

  it('maps timeouts to a clear error', async () => {
    stub(async () => {
      throw Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' });
    });
    await expect(httpTransport(req)).rejects.toThrow('/api/decide timed out after 2500 ms');
  });
});

describe('createHttpTransport hooks', () => {
  const json = (body: unknown, status: number) => async () => new Response(JSON.stringify(body), { status });

  it('reports a signed-out player once, and only that', async () => {
    const onSignedOut = vi.fn();
    const onWalletEmpty = vi.fn();
    stub(json({ error: 'expired', signedOut: true }, 401));
    await expect(createHttpTransport({ onSignedOut, onWalletEmpty })(req)).rejects.toThrow('expired');
    expect(onSignedOut).toHaveBeenCalledOnce();
    expect(onWalletEmpty).not.toHaveBeenCalled();
  });

  it('reports an empty wallet once, and only that', async () => {
    const onSignedOut = vi.fn();
    const onWalletEmpty = vi.fn();
    stub(json({ error: 'empty', walletUrl: 'https://platform.opper.ai/wallet' }, 402));
    await expect(createHttpTransport({ onSignedOut, onWalletEmpty })(req)).rejects.toThrow('empty');
    expect(onWalletEmpty).toHaveBeenCalledOnce();
    expect(onWalletEmpty).toHaveBeenCalledWith('https://platform.opper.ai/wallet');
    expect(onSignedOut).not.toHaveBeenCalled();
  });

  it('calls no hook for a 401 without signedOut or a 402 without walletUrl', async () => {
    const onSignedOut = vi.fn();
    const onWalletEmpty = vi.fn();
    const t = createHttpTransport({ onSignedOut, onWalletEmpty });
    stub(json({ error: 'nope' }, 401));
    await expect(t(req)).rejects.toThrow('nope');
    stub(json({ error: 'poor' }, 402));
    await expect(t(req)).rejects.toThrow('poor');
    expect(onSignedOut).not.toHaveBeenCalled();
    expect(onWalletEmpty).not.toHaveBeenCalled();
  });

  it('still rejects with the server message when a hook throws', async () => {
    const boom = () => {
      throw new Error('hook exploded');
    };
    const t = createHttpTransport({ onSignedOut: boom, onWalletEmpty: boom });
    stub(json({ error: 'expired', signedOut: true }, 401));
    await expect(t(req)).rejects.toThrow('expired');
    stub(json({ error: 'empty', walletUrl: 'https://platform.opper.ai/wallet' }, 402));
    await expect(t(req)).rejects.toThrow('empty');
  });
});
