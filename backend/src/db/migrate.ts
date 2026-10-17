import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { migrate } from 'drizzle-orm/node-postgres/migrator'

import type { Database } from './client.js'

/**
 * Location of the generated SQL migrations.
 *
 * Resolved relative to this module so it is correct both when running from
 * `src/` under tsx and from `dist/` after a build.
 */
export const DEFAULT_MIGRATIONS_FOLDER = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../drizzle',
)

/**
 * Applies every pending migration.
 *
 * Drizzle records applied migrations in `drizzle.__drizzle_migrations`, so the
 * operation is idempotent and safe to run on every startup or test run.
 */
export async function runMigrations(
  database: Database,
  migrationsFolder: string = DEFAULT_MIGRATIONS_FOLDER,
): Promise<void> {
  await migrate(database.orm, { migrationsFolder })
}
