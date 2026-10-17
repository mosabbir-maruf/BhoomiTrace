import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Integration tests share one PostgreSQL database, and migrations must not
    // race between workers. Serial file execution keeps runs deterministic.
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 60_000,
    reporters: ['default'],
  },
})
