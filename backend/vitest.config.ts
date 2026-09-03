import { defineConfig } from 'vitest/config';

// Two projects:
//   unit        — pure TypeScript, no database, fast.
//   integration — every test file starts its own PostgreSQL container (test/helpers/database.ts),
//                 applies the forward-only migrations and runs under the runtime role.
// Files and tests are shuffled on every run so order dependence surfaces as a failure.
export default defineConfig({
  test: {
    reporters: ['default'],
    teardownTimeout: 60_000,
    projects: [
      {
        test: {
          name: 'unit',
          include: ['test/unit/**/*.test.ts'],
          environment: 'node',
          testTimeout: 10_000,
        },
      },
      {
        test: {
          name: 'integration',
          include: ['test/integration/**/*.test.ts'],
          environment: 'node',
          testTimeout: 90_000,
          hookTimeout: 240_000,
          fileParallelism: true,
          sequence: { shuffle: { files: true, tests: true } },
        },
      },
    ],
  },
});
