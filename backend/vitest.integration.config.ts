import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Real-Postgres integration scope: the single
    // src/interfaces/http/integration-test.ts file (7 tests, sequential,
    // no cross-file DB interference). Unit scope (vitest.config.ts)
    // EXCLUDES this file so `npm run test` stays offline
    // (7 files / 46 tests).
    include: ['src/**/*.integration.test.ts', 'src/**/integration-test.ts'],
    exclude: ['node_modules', 'dist'],
    testTimeout: 60000,
    hookTimeout: 60000,
    pool: 'forks',
    // Single fork: the integration tests mutate shared DB state and must run
    // in one process in order. This is the vitest-5 form of the option; move
    // it under top-level pool config when the next vitest major lands.
    poolOptions: { forks: { singleFork: true } },
    sequence: { shuffle: false },
  },
});
