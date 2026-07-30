import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@config': r('./config'),
      '@wayfinder/shared': r('./packages/shared/index.ts'),
      '@wayfinder/engine': r('./packages/engine/index.ts'),
      '@wayfinder/pipeline': r('./packages/pipeline'),
    },
  },
  test: {
    include: ['tests/**/*.test.ts', 'packages/**/*.test.ts'],
    // Globs, not bare directory names. `exclude` REPLACES vitest's defaults, and a bare
    // 'node_modules' matches only the top-level one, so `packages/client/node_modules` leaked in
    // and the run started executing maplibre-gl's own 1,000+ tests as if they were ours.
    exclude: [
      '**/node_modules/**',
      '**/data/**',
      '**/tools/**',
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
    ],
    // Golden-route and cross-algorithm suites run 1000 pairs. Default 5s is too tight.
    testTimeout: 60_000,
    reporters: ['default'],
  },
});
