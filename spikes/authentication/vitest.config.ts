import { defineConfig } from 'vitest/config';

// Spike test configuration. The database test file starts its own PostgreSQL container
// (test/helpers/database.ts); unit files need none. Files and tests are shuffled on every run so
// order dependence surfaces as a failure. No test sleeps: expiry is proven by backdating rows.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 90_000,
    hookTimeout: 240_000,
    teardownTimeout: 60_000,
    fileParallelism: true,
    sequence: { shuffle: { files: true, tests: true } },
    reporters: ['default'],
  },
});
