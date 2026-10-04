// Production entry point: `node server/main.ts` (Node ≥ 22.18 runs the TypeScript directly).
import { fileURLToPath } from 'node:url';
import { createApp } from './app.ts';

const port = Number(process.env.PORT || 3000);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT must be a valid port number');

const app = createApp({
  env: process.env,
  distDir: fileURLToPath(new URL('../dist', import.meta.url)),
  commit: process.env.SOURCE_COMMIT || 'local',
});

await app.listen(port);

process.once('SIGTERM', () => {
  void app.shutdown().then((outcome) => process.exit(outcome === 'clean' ? 0 : 1));
});
process.once('SIGINT', () => {
  void app.shutdown().then((outcome) => process.exit(outcome === 'clean' ? 0 : 1));
});
