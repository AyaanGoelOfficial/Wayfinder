import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@config': r('./config'),
      '@wayfinder/shared': r('./packages/shared/index.ts'),
      '@wayfinder/engine': r('./packages/engine/index.ts'),
    },
  },
  test: {
    include: ['tests/**/*.test.ts', 'packages/**/*.test.ts'],
    exclude: ['node_modules', 'data', 'tools', 'dist'],
    // Golden-route and cross-algorithm suites run 1000 pairs. Default 5s is too tight.
    testTimeout: 60_000,
    reporters: ['default'],
  },
});
