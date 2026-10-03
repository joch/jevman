/// <reference types="vitest/config" />
import { defineConfig, loadEnv } from 'vite';
import { jevPlugin } from './server/decide.ts';

export default defineConfig(({ mode }) => ({
  plugins: [jevPlugin(loadEnv(mode, process.cwd(), 'OPPER_'))],
  test: { include: ['tests/**/*.test.ts'] },
}));
