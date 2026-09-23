import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Real-Postgres integration scope per plan Todo 13: the single
    // src/flash-sale.integration.test.ts file (sequential, no cross-file DB
    // interference). Unit scope (vitest.config.ts) EXCLUDES this file so
    // `npm run test` stays offline (4 files / 38 tests).
    include: ['src/**/*.integration.test.ts'],
    exclude: ['node_modules', 'dist'],
    testTimeout: 60000,
    hookTimeout: 60000,
    pool: 'forks',
    // NOTE: vitest 5 prints a "poolOptions removed in Vitest 4" deprecation
    // warning for the line below, but singleFork still takes effect on the
    // pinned vitest 5.0.1 (verbose run shows sequential single-file exec).
    // Migrate to top-level pool options only when bumping vitest major.
    poolOptions: { forks: { singleFork: true } },
    sequence: { shuffle: false },
  },
});
