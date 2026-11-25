import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';

const repoRoot = path.resolve(__dirname, '../..');

export default defineConfig({
  root: repoRoot,
  plugins: [react()],
  css: {
    postcss: { plugins: [] },
  },
  resolve: {
    alias: {
      '@': path.resolve(repoRoot, 'web/src'),
      '@mobile': path.resolve(repoRoot, 'mobile/src'),
      react: path.resolve(repoRoot, 'node_modules/react'),
      'react-dom': path.resolve(repoRoot, 'node_modules/react-dom'),
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    environmentOptions: {
      jsdom: { url: 'http://localhost:3000' },
    },
    setupFiles: [path.resolve(__dirname, 'setup-dom.ts')],
    include: [
      'tests/e2e/frontend/**/*.e2e.test.{ts,tsx}',
      'tests/e2e/scenarios/dom/**/*.e2e.test.{ts,tsx}',
    ],
    exclude: ['**/node_modules/**', 'web/**', 'backend/**', 'mobile/**'],
    testTimeout: 15000,
    hookTimeout: 15000,
    fileParallelism: false,
    restoreMocks: false,
    clearMocks: false,
  },
});
