import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Run ONLY src tests: tsc emits compiled dist/**/*.test.js twins that
    // Vitest otherwise picks up and double-counts (8 files/76 tests for
    // 4 unique suites). Unit scope per plan Todo 11.
    include: ['src/**/*.test.ts'],
    exclude: ['node_modules', 'dist', 'src/**/*.integration.test.ts'],
  },
});
