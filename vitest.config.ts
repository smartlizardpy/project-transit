import { defineConfig } from 'vitest/config';

// The game core is plain TypeScript; tests run in Node against the real bundled map tiles.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'mcp/**/*.test.ts'],
    // the 40-day progression run takes ~2 min on a desktop and several on shared CI runners
    testTimeout: process.env.CI ? 900_000 : 180_000,
  },
});
