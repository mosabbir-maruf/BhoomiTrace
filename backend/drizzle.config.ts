import { defineConfig } from 'drizzle-kit'

/**
 * Drizzle Kit configuration.
 *
 * `generate` only diffs the schema against the previous snapshot and does not
 * connect to a database. `push` / `studio` do connect, so the default below
 * points at the local Compose instance. Secrets are never stored here: supply
 * `DATABASE_URL` through the environment for anything other than localhost.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema/index.ts',
  out: './drizzle',
  strict: true,
  verbose: true,
  dbCredentials: {
    url:
      process.env.DATABASE_URL ??
      'postgres://bhoomitrace:bhoomitrace@127.0.0.1:5433/bhoomitrace',
  },
})
