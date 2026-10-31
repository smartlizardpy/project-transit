import { configDefaults, defineConfig } from 'vitest/config';

// Timing budgets (perf.test.ts) are measured alone, after the other files: run alongside three
// other CPU-bound workers they read about 1.5× slower than they are.
const TIMED = ['src/game/test/perf.test.ts'];

// The game core is plain TypeScript; tests run in Node against the real bundled map tiles.
export default defineConfig({
  test: {
    // the 40-day progression run takes ~2 min on a desktop and several on shared CI runners
    testTimeout: process.env.CI ? 900_000 : 180_000,
    // the long simulations are CPU bound: more workers than fast cores makes them all slower
    // (on a 12-thread laptop the default ran 4–5× slower per test and timed out; 4 finishes in ~90 s)
    maxWorkers: 4,
    projects: [
      { extends: true, test: { name: 'game', include: ['src/**/*.test.ts', 'mcp/**/*.test.ts'], exclude: [...configDefaults.exclude, ...TIMED] } },
      { extends: true, test: { name: 'timing', include: TIMED, sequence: { groupOrder: 1 } } },
    ],
  },
});
