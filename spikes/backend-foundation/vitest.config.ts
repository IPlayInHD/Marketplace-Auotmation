import { defineConfig } from 'vitest/config';

// Spike test configuration.
// - Every database test file starts its own PostgreSQL container (see test/helpers/database.ts),
//   so files are fully isolated and can run in parallel and in any order.
// - Files and tests are shuffled on every run so order dependence surfaces as a failure.
// - Timeouts are generous but finite: a broken worker test fails instead of hanging.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 90_000,
    hookTimeout: 240_000,
    teardownTimeout: 60_000,
    fileParallelism: true,
    sequence: { shuffle: { files: true, tests: true } },
    reporters: ['default'],
  },
});
