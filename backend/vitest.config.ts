import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Layered unit scope: 7 offline suites / 46 tests under src —
    // services/sale, services/purchase, models/requests, repositories
    // (postgres/cache/logger) + interfaces/http. dist/ twins are excluded
    // so tsc output never double-counts. Integration (real Postgres) lives
    // in src/interfaces/http/integration-test.ts and is excluded here.
    include: ['src/**/*.test.ts', 'src/**/test.ts'],
    exclude: ['node_modules', 'dist', 'src/**/*.integration.test.ts', 'src/**/integration-test.ts'],
  },
});
