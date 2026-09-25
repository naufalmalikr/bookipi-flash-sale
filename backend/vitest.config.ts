import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Layered unit scope: 9 offline suites / 67 tests under src —
    // services/sale, services/purchase, models/requests, repositories
    // (postgres/cache/logger) + interfaces/http + Config + utilities.
    // dist/ twins are excluded
    // so tsc output never double-counts. Integration (real Postgres) lives
    // in src/interfaces/http/integration/ and is excluded here.
    include: ['src/**/*.test.ts', 'src/**/test.ts'],
    exclude: ['node_modules', 'dist', 'src/**/*.integration.test.ts', 'src/**/integration-test.ts', 'src/interfaces/http/integration/**'],
  },
});
