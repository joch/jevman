import type { Plugin } from 'vite';
import { createJevMiddleware } from './routes.ts';

/** Mounts the jev routes (Login with Opper, /api/me, /api/decide) on the Vite dev and preview servers. */
/** The production server's clean URL for the leaderboard page. */
export function cleanUrls(req: { url?: string }, _res: unknown, next: () => void): void {
  if (req.url?.split('?')[0] === '/leaderboard') req.url = req.url.replace('/leaderboard', '/leaderboard.html');
  next();
}

export function jevPlugin(env: Record<string, string>, opts: { quiet?: boolean } = {}): Plugin {
  return {
    name: 'jev-decide',
    configureServer(server) {
      server.middlewares.use(createJevMiddleware(env, server.config.logger, opts));
      server.middlewares.use(cleanUrls);
    },
    configurePreviewServer(server) {
      server.middlewares.use(createJevMiddleware(env, server.config.logger, opts));
      server.middlewares.use(cleanUrls);
    },
  };
}
