import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Real-Postgres integration scope: the four
    // src/interfaces/http/integration/*.integration.test.ts files (10
    // tests, sequential, no cross-file DB interference — every test reseeds
    // via resetDb first). Unit scope (vitest.config.ts) EXCLUDES this dir
    // so `npm run test` stays offline.
    include: ['src/**/*.integration.test.ts', 'src/**/integration-test.ts'],
    exclude: ['node_modules', 'dist'],
    testTimeout: 60000,
    hookTimeout: 60000,
    pool: 'forks',
    // Vitest 4 removed `test.poolOptions` (singleFork -> maxWorkers:1 +
    // isolate:false per the pool-rework migration). Single shared worker,
    // files serialized below so resetDb cannot interleave across files.
    isolate: false,
    sequence: { shuffle: false },
    // Four files share one DB (sale_config id=1); run files one at a time
    // so resetDb in one file cannot wipe another file's seed mid-test.
    fileParallelism: false,
    maxWorkers: 1,
    env: { INTEGRATION_RESEED: '1' },
  },
});
