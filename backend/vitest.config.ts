import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    globalSetup: ['tests/global-setup.ts'],
    testTimeout: 20_000,
    hookTimeout: 60_000,
    // Integration tests share one SQLite file; serialising avoids lock churn and
    // keeps the schema-constraint assertions deterministic.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
})
