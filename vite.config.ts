/// <reference types="vitest/config" />
import { defineConfig, loadEnv } from 'vite';
import { jevPlugin } from './server/plugin.ts';

export default defineConfig(({ mode }) => ({
  plugins: [jevPlugin(loadEnv(mode, process.cwd(), ['OPPER_', 'SESSION_', 'JEV_', 'TYPESAFE_']))],
  build: { rollupOptions: { input: { main: 'index.html', leaderboard: 'leaderboard.html' } } },
  // Some tests replay whole games, which can take several seconds on a busy CI runner.
  test: { include: ['tests/**/*.test.ts'], testTimeout: 30_000 },
}));
