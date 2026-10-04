import type { Plugin } from 'vite';
import { createJevMiddleware } from './routes.ts';

/** Mounts the jev routes (Login with Opper, /api/me, /api/decide) on the Vite dev and preview servers. */
export function jevPlugin(env: Record<string, string>, opts: { quiet?: boolean } = {}): Plugin {
  return {
    name: 'jev-decide',
    configureServer(server) {
      server.middlewares.use(createJevMiddleware(env, server.config.logger, opts));
    },
    configurePreviewServer(server) {
      server.middlewares.use(createJevMiddleware(env, server.config.logger, opts));
    },
  };
}
