import { describeEnvironment, loadEnvironment } from '../config/env.js'
import { loadEnvFile } from '../config/load-env.js'
import { createDatabase, databaseConfigFromEnvironment } from './client.js'
import { runMigrations } from './migrate.js'

/** CLI entry point: `npm run db:migrate`. */
loadEnvFile()

const env = loadEnvironment()
const database = createDatabase(databaseConfigFromEnvironment(env))

try {
  console.log(
    `Applying migrations as ${JSON.stringify(describeEnvironment(env))}`,
  )
  await runMigrations(database)
  console.log('Migrations applied successfully.')
} catch (error) {
  console.error(
    `Migration failed: ${error instanceof Error ? error.message : String(error)}`,
  )
  process.exitCode = 1
} finally {
  await database.close()
}
