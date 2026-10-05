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

/**
 * One tiny call (POST /api/warm) so a model that has been idle (Opper scales them down) is awake before it has to
 * play. It bills one small call. Resolves true when the model answered; `model` undefined warms the server's default.
 */
export async function warmUp(model: string | undefined): Promise<boolean> {
  try {
    const res = await fetch('/api/warm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(model ? { model } : {}),
      signal: AbortSignal.timeout(35_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
