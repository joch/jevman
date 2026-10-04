import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import { clearSessionCookie, handleCallback, handleLogin, handleLogout, handleMe, opperExchange, sessionFrom, type AuthConfig, type HttpRequest, type HttpResponse } from './auth.ts';
import { handleDecide, resolveKey } from './decide.ts';

export function authConfigFromEnv(env: Record<string, string>, warn: (msg: string) => void): AuthConfig {
  let sessionSecret = env.SESSION_SECRET ?? '';
  if (sessionSecret.length < 32) {
    warn('[auth] SESSION_SECRET is missing or shorter than 32 characters — using a random one; sign-ins reset on restart');
    sessionSecret = randomBytes(32).toString('hex');
  }
  return {
    clientId: env.OPPER_CLIENT_ID || undefined,
    clientSecret: env.OPPER_CLIENT_SECRET || undefined,
    redirectUri: env.OPPER_REDIRECT_URI || 'http://localhost:5173/auth/callback',
    opperUrl: env.OPPER_BASE_URL || 'https://api.opper.ai',
    sessionSecret,
  };
}

const toHttp = (req: IncomingMessage): HttpRequest => ({ method: req.method ?? 'GET', url: req.url ?? '/', headers: req.headers });

function send(res: ServerResponse, r: HttpResponse): void {
  res.statusCode = r.status;
  for (const [k, v] of Object.entries(r.headers)) if (!(Array.isArray(v) && v.length === 0)) res.setHeader(k, v);
  res.end(r.body);
}

const sendJson = (res: ServerResponse, status: number, body: unknown, setCookie?: string) =>
  send(res, { status, headers: { 'Content-Type': 'application/json', ...(setCookie ? { 'Set-Cookie': setCookie } : {}) }, body: JSON.stringify(body) });

/** Dev-server routes: Login with Opper, the account endpoint and the jev proxy. The dev key never leaves the server. */
export function jevPlugin(env: Record<string, string>): Plugin {
  return {
    name: 'jev-decide',
    configureServer(server) {
      const logger = server.config.logger;
      const quiet = Boolean(process.env.VITEST);
      const cfg = authConfigFromEnv(env, (m) => logger.warn(m));
      const devKey = env.OPPER_API_KEY || undefined;
      if (!devKey && !cfg.clientId && !quiet) logger.warn('[jev] neither OPPER_API_KEY nor OPPER_CLIENT_ID/SECRET is set — jev cannot play');
      const redactSecrets = (s: string) => [cfg.clientSecret, devKey].reduce<string>((acc, k) => (k ? acc.split(k).join('[redacted]') : acc), s);
      const baseExchange = opperExchange(cfg);
      // handleCallback maps any failure to /?auth_error=exchange; log why (message only, redacted) so a misconfigured app is diagnosable.
      const exchange: typeof baseExchange = async (code) => {
        try {
          return await baseExchange(code);
        } catch (err) {
          logger.warn(`[auth] token exchange failed: ${redactSecrets((err as Error)?.message ?? String(err))}`);
          throw err;
        }
      };

      server.middlewares.use((req: IncomingMessage, res: ServerResponse, next: () => void) => {
        const path = (req.url ?? '').split('?')[0];
        const http = toHttp(req);
        if (path === '/auth/login') return send(res, handleLogin(http, cfg));
        if (path === '/auth/callback') {
          void handleCallback(http, cfg, exchange).then((r) => send(res, r), () => send(res, { status: 302, headers: { Location: '/?auth_error=exchange' }, body: '' }));
          return;
        }
        if (path === '/auth/logout') return send(res, handleLogout(http, cfg));
        if (path === '/api/me') return send(res, handleMe(http, cfg, Boolean(devKey)));
        if (path !== '/api/decide') return next();

        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end();
          return;
        }
        // A cross-site form can send text/plain without a CORS preflight; require JSON so only our own page can spend credit.
        if (!String(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
          return sendJson(res, 415, { error: 'Expected application/json' });
        }
        const key = resolveKey(sessionFrom(http, cfg), devKey);
        const redact = (s: string) => [key?.apiKey, devKey].reduce<string>((acc, k) => (k ? acc.split(k).join('[redacted]') : acc), s);
        let raw = '';
        const fail = (error: string): void => {
          if (!res.headersSent) sendJson(res, 500, { error });
          else res.end();
        };
        req.on('error', (err) => fail(`request failed: ${redact(err.message)}`));
        req.on('data', (chunk) => (raw += chunk));
        req.on('end', async () => {
          try {
            if (!key) return sendJson(res, 401, { error: 'Sign in with Opper to let jev play', signedOut: true });
            let input: unknown = null;
            try {
              input = JSON.parse(raw);
            } catch {
              // handled as a 400 by handleDecide
            }
            const result = await handleDecide(input, {
              apiKey: key.apiKey,
              keyMode: key.mode,
              baseUrl: cfg.opperUrl,
              fetch,
              now: () => performance.now(),
              log: (line) => logger.info(line, { timestamp: true }),
            });
            const { clearSession, ...body } = result.body as Record<string, unknown>;
            sendJson(res, result.status, body, clearSession ? clearSessionCookie(cfg) : undefined);
          } catch (err) {
            logger.error(`[jev] middleware failure: ${redact((err as Error)?.message ?? String(err))}`);
            fail('internal error in /api/decide');
          }
        });
      });
    },
  };
}
