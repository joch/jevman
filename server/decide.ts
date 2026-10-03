import type { Plugin } from 'vite';

export const JEV_MODEL = 'typesafe/jev-1.13.0';

export interface DecideDeps {
  apiKey: string | undefined;
  baseUrl: string;
  fetch: typeof fetch;
  now: () => number;
  timeoutMs?: number;
  log?: (line: string) => void;
}

export interface DecideResult {
  status: number;
  body: unknown;
}

interface DecideInput {
  state: unknown;
  questions: Record<string, unknown>;
}

function isDecideInput(v: unknown): v is DecideInput {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return o.state !== undefined && !!o.questions && typeof o.questions === 'object' && Object.keys(o.questions).length > 0;
}

function upstreamMessage(text: string): string {
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    if (typeof parsed.error === 'string') return parsed.error;
  } catch {
    // not JSON; use the raw text
  }
  return text.slice(0, 200);
}

export async function handleDecide(input: unknown, deps: DecideDeps): Promise<DecideResult> {
  const apiKey = deps.apiKey;
  const redact = (s: string): string => (apiKey ? s.split(apiKey).join('[redacted]') : s);
  const rawLog = deps.log ?? (() => {});
  const log = (line: string): void => rawLog(redact(line));
  const timeoutMs = deps.timeoutMs ?? 2000;
  if (!deps.apiKey) return { status: 500, body: { error: 'No OPPER_API_KEY in .env — all decisions are fallbacks' } };
  if (!isDecideInput(input)) return { status: 400, body: { error: 'Expected { state, questions } with at least one question' } };

  const actors = Object.keys(input.questions).join(',');
  const started = deps.now();
  try {
    const res = await deps.fetch(`${deps.baseUrl.replace(/\/+$/, '')}/v3/compat/v1/systemone`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${deps.apiKey}`,
        'Content-Type': 'application/json',
        'X-Opper-Name': 'jevman-decide',
      },
      body: JSON.stringify({ model: JEV_MODEL, state: input.state, questions: input.questions }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    const latencyMs = Math.round(deps.now() - started);
    if (!res.ok) {
      const error = redact(`jev returned HTTP ${res.status}: ${upstreamMessage(text)}`);
      log(`[jev] ${actors} failed after ${latencyMs} ms — ${error}`);
      return { status: 502, body: { error } };
    }
    const json = JSON.parse(text) as { answers?: Record<string, unknown>; usage?: { input_tokens: number; output_tokens: number } };
    const cost = res.headers.get('x-opper-cost');
    const traceId = res.headers.get('x-opper-trace-id');
    log(`[jev] ${actors} ok in ${latencyMs} ms, cost ${cost ?? '?'} USD, trace ${traceId ?? '?'}`);
    return {
      status: 200,
      body: {
        answers: json.answers ?? {},
        usage: json.usage ?? { input_tokens: 0, output_tokens: 0 },
        latencyMs,
        costUsd: cost === null ? null : Number(cost),
        traceId,
      },
    };
  } catch (err) {
    const e = err as Error;
    const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError';
    const error = timedOut ? `jev timed out after ${timeoutMs} ms` : redact(`jev request failed: ${e?.message ?? String(err)}`);
    log(`[jev] ${actors} ${error}`);
    return { status: timedOut ? 504 : 502, body: { error } };
  }
}

/** Vite dev-server middleware exposing POST /api/decide. The key stays on the server. */
export function jevPlugin(env: Record<string, string>): Plugin {
  return {
    name: 'jev-decide',
    configureServer(server) {
      if (!env.OPPER_API_KEY && !process.env.VITEST) server.config.logger.warn('[jev] OPPER_API_KEY is not set in .env — all decisions will be fallbacks');
      server.middlewares.use('/api/decide', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end();
          return;
        }
        // A cross-site form can send text/plain without a CORS preflight; require JSON so only our own page can spend credit.
        if (!String(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
          res.statusCode = 415;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'Expected application/json' }));
          return;
        }
        let raw = '';
        const fail = (error: string): void => {
          if (!res.headersSent) {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error }));
          } else {
            res.end();
          }
        };
        req.on('error', (err) => fail(`request failed: ${err.message}`));
        req.on('data', (chunk) => (raw += chunk));
        req.on('end', async () => {
          try {
            let input: unknown = null;
            try {
              input = JSON.parse(raw);
            } catch {
              // handled as a 400 by handleDecide
            }
            const result = await handleDecide(input, {
              apiKey: env.OPPER_API_KEY,
              baseUrl: env.OPPER_BASE_URL || 'https://api.opper.ai',
              fetch,
              now: () => performance.now(),
              log: (line) => server.config.logger.info(line, { timestamp: true }),
            });
            res.statusCode = result.status;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(result.body));
          } catch (err) {
            const message = (err as Error)?.message ?? String(err);
            server.config.logger.error(`[jev] middleware failure: ${env.OPPER_API_KEY ? message.split(env.OPPER_API_KEY).join('[redacted]') : message}`);
            fail('internal error in /api/decide');
          }
        });
      });
    },
  };
}
