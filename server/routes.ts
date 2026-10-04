import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleCallback, handleLogin, handleLogout, handleMe, json, loginConfigured, opperExchange, redirect, type AuthConfig, type HttpRequest, type HttpResponse } from './auth.ts';
import { handleDecideRequest, rejectDecideRequest } from './decide.ts';

/** Largest /api/decide body read; a game state plus five questions is a few KB. */
export const MAX_BODY_BYTES = 256 * 1024;
const MAX_LOG_CHARS = 300;

export interface RouteLogger {
  info(msg: string, opts?: { timestamp?: boolean }): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export type Middleware = (req: IncomingMessage, res: ServerResponse, next: () => void) => void;

const isHttps = (env: Record<string, string>) => (env.OPPER_REDIRECT_URI ?? '').startsWith('https:');

/** Auth settings from the environment. An https redirect URI means a deployment, which needs a real SESSION_SECRET. */
export function authConfigFromEnv(env: Record<string, string>, warn: (msg: string) => void): AuthConfig {
  const clientId = env.OPPER_CLIENT_ID || undefined;
  const clientSecret = env.OPPER_CLIENT_SECRET || undefined;
  let sessionSecret = env.SESSION_SECRET ?? '';
  if (sessionSecret.length < 32) {
    if (isHttps(env)) throw new Error('[auth] SESSION_SECRET must be set to at least 32 characters when OPPER_REDIRECT_URI is https');
    if (clientId && clientSecret) warn('[auth] SESSION_SECRET is missing or shorter than 32 characters — using a random one; sign-ins reset on restart');
    sessionSecret = randomBytes(32).toString('hex');
  }
  return {
    clientId,
    clientSecret,
    redirectUri: env.OPPER_REDIRECT_URI || 'http://localhost:5173/auth/callback',
    opperUrl: env.OPPER_BASE_URL || 'https://api.opper.ai',
    sessionSecret,
  };
}

/** The local dev key, unless this is a deployment (https redirect URI), where it would pay for every visitor. */
export function devKeyFromEnv(env: Record<string, string>, cfg: AuthConfig, warn: (msg: string) => void): string | undefined {
  const key = env.OPPER_API_KEY || undefined;
  if (!key || !cfg.redirectUri.startsWith('https:')) return key;
  if (env.JEV_ALLOW_DEV_KEY !== '1') {
    warn('[jev] OPPER_API_KEY is ignored because OPPER_REDIRECT_URI is https — a deployed site must not pay for visitors with a server key. Set JEV_ALLOW_DEV_KEY=1 to use it anyway.');
    return undefined;
  }
  warn('[jev] JEV_ALLOW_DEV_KEY=1: OPPER_API_KEY pays for every signed-out visitor of this https deployment');
  return key;
}

const toHttp = (req: IncomingMessage): HttpRequest => ({ method: req.method ?? 'GET', url: req.url ?? '/', headers: req.headers });

function send(res: ServerResponse, r: HttpResponse): void {
  res.statusCode = r.status;
  for (const [k, v] of Object.entries(r.headers)) if (!(Array.isArray(v) && v.length === 0)) res.setHeader(k, v);
  res.end(r.body);
}

/** Last resort when writing a response failed: end it so the request never hangs. */
function abort(res: ServerResponse): void {
  if (!res.headersSent) res.statusCode = 500;
  res.end();
}

/** The request body as UTF-8, or null once it grows past `limit` bytes. */
function readBody(req: IncomingMessage, limit: number): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on('data', (chunk: Buffer | string) => {
      if (over) return;
      const b = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      size += b.length;
      if (size > limit) {
        over = true;
        resolve(null);
      } else chunks.push(b);
    });
    req.on('end', () => {
      if (!over) resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

/**
 * Connect-style middleware for Login with Opper, the account endpoint and the jev proxy, for the Vite dev and
 * preview servers (or any Node HTTP server). The player and dev keys never leave the server.
 */
export function createJevMiddleware(env: Record<string, string>, logger: RouteLogger, opts: { quiet?: boolean } = {}): Middleware {
  const cfg = authConfigFromEnv(env, (m) => logger.warn(m));
  const devKey = devKeyFromEnv(env, cfg, (m) => logger.warn(m));
  if (!devKey && !loginConfigured(cfg) && !opts.quiet) logger.warn('[jev] neither OPPER_API_KEY nor OPPER_CLIENT_ID/SECRET is set — jev cannot play');
  const redactSecrets = (s: string) => [cfg.clientSecret, devKey].reduce<string>((acc, k) => (k ? acc.split(k).join('[redacted]') : acc), s);
  const baseExchange = opperExchange(cfg);
  // handleCallback maps any failure to /?auth_error=exchange; log why (message only, redacted, capped) so a misconfigured app is diagnosable.
  const exchange: typeof baseExchange = async (code) => {
    try {
      return await baseExchange(code);
    } catch (err) {
      logger.warn(`[auth] token exchange failed: ${redactSecrets((err as Error)?.message ?? String(err)).slice(0, MAX_LOG_CHARS)}`);
      throw err;
    }
  };

  return (req, res, next) => {
    const path = (req.url ?? '').split('?')[0];
    const http = toHttp(req);
    if (path === '/auth/login') return send(res, handleLogin(http, cfg));
    if (path === '/auth/callback') {
      void handleCallback(http, cfg, exchange)
        .then((r) => send(res, r), () => send(res, redirect('/?auth_error=exchange')))
        .catch(() => abort(res));
      return;
    }
    if (path === '/auth/logout') return send(res, handleLogout(http, cfg));
    if (path === '/api/me') return send(res, handleMe(http, cfg, Boolean(devKey)));
    if (path !== '/api/decide') return next();

    // Refuse what needs no body (wrong method, cross-site, not JSON, signed out) before reading any of it.
    const refused = rejectDecideRequest(http, cfg, devKey);
    if (refused) return send(res, refused);
    const redact = (s: string) => (devKey ? s.split(devKey).join('[redacted]') : s);
    readBody(req, MAX_BODY_BYTES)
      .then(async (raw) => {
        if (raw === null) return send(res, json(413, { error: 'Request body too large' }, [], { Connection: 'close' }));
        const r = await handleDecideRequest(http, raw, cfg, devKey, {
          fetch,
          now: () => performance.now(),
          log: (line) => logger.info(line, { timestamp: true }),
          logError: (line) => logger.error(line),
        });
        send(res, r);
      })
      .catch((err) => {
        try {
          logger.error(`[jev] /api/decide request failed: ${redact((err as Error)?.message ?? String(err)).slice(0, MAX_LOG_CHARS)}`);
          if (!res.headersSent) return send(res, json(500, { error: 'internal error in /api/decide' }));
        } catch {
          // fall through to abort
        }
        abort(res);
      });
  };
}
