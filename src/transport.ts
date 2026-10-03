import type { DecideResponse } from './brain';
import type { Transport } from './scheduler';

export const httpTransport: Transport = async (body) => {
  const res = await fetch('/api/decide', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(2500),
  });
  const json = (await res.json().catch(() => ({}))) as Partial<DecideResponse> & { error?: string };
  if (!res.ok) throw new Error(json.error ?? `/api/decide returned HTTP ${res.status}`);
  return json as DecideResponse;
};
