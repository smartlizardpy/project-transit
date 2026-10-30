import { defineConfig } from 'vitest/config';

// The game core is plain TypeScript; tests run in Node against the real bundled map tiles.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'mcp/**/*.test.ts'],
    testTimeout: 180_000,
  },
});
