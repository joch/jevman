import type { DecideResponse } from './brain';
import type { Transport } from './scheduler';

const TIMEOUT_MS = 2500;

export const httpTransport: Transport = async (body) => {
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
  if (!res.ok) throw new Error(json.error ?? `/api/decide returned HTTP ${res.status}`);
  if (!json.answers || typeof json.answers !== 'object' || !json.usage) throw new Error('/api/decide returned an invalid response');
  return json as DecideResponse;
};
