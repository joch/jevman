import type { DecideResponse } from './brain';
import type { Transport } from './scheduler';

const TIMEOUT_MS = 2500;

export interface TransportHooks {
  onSignedOut?: () => void;
  onWalletEmpty?: (url: string) => void;
}

export function createHttpTransport(hooks: TransportHooks = {}): Transport {
  return async (body) => {
    let res: Response;
    let json: Partial<DecideResponse> & { error?: string };
    try {
      res = await fetch('/api/decide', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      json = (await res.json().catch((err: Error) => {
        if (err?.name === 'TimeoutError' || err?.name === 'AbortError') throw err;
        return {};
      })) as typeof json;
    } catch (err) {
      const name = (err as Error)?.name;
      if (name === 'TimeoutError' || name === 'AbortError') throw new Error(`/api/decide timed out after ${TIMEOUT_MS} ms`);
      throw err;
    }
    if (!res.ok) {
      try {
        if ((json as { signedOut?: boolean }).signedOut) hooks.onSignedOut?.();
        if (res.status === 402 && typeof (json as { walletUrl?: unknown }).walletUrl === 'string') hooks.onWalletEmpty?.((json as { walletUrl: string }).walletUrl);
      } catch {
        // a faulty hook must not replace the server's error message
      }
      throw new Error(json.error ?? `/api/decide returned HTTP ${res.status}`);
    }
    if (!json.answers || typeof json.answers !== 'object' || !json.usage) throw new Error('/api/decide returned an invalid response');
    return json as DecideResponse;
  };
}

export const httpTransport: Transport = createHttpTransport();

export type WarmResult = { ok: true } | { ok: false; error: string; account: boolean };

/**
 * One tiny call (POST /api/warm) so a model that has been idle (Opper scales them down) is awake before it has to
 * play. It bills one small call; `model` undefined warms the server's default. An expired sign-in or an empty wallet
 * goes through the same hooks as a game call, and comes back as an account problem rather than a sleepy model.
 */
export async function warmUp(model: string | undefined, hooks: TransportHooks = {}): Promise<WarmResult> {
  try {
    const res = await fetch('/api/warm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(model ? { model } : {}),
      signal: AbortSignal.timeout(35_000),
    });
    if (res.ok) return { ok: true };
    const json = (await res.json().catch(() => ({}))) as { error?: string; signedOut?: boolean; walletUrl?: unknown };
    const signedOut = json.signedOut === true;
    const wallet = res.status === 402 && typeof json.walletUrl === 'string';
    try {
      if (signedOut) hooks.onSignedOut?.();
      if (wallet) hooks.onWalletEmpty?.(json.walletUrl as string);
    } catch {
      // a faulty hook must not hide the result
    }
    return { ok: false, error: json.error ?? `HTTP ${res.status}`, account: signedOut || wallet };
  } catch {
    return { ok: false, error: 'no answer', account: false };
  }
}
