import { loadEnvironment } from '../config/env.js'
import { loadEnvFile } from '../config/load-env.js'
import { createDatabase, databaseConfigFromEnvironment } from './client.js'
import { runMigrations } from './migrate.js'
import { seedSyntheticData } from './seed.js'

/** CLI entry point: `npm run db:seed`. */
loadEnvFile()

const env = loadEnvironment()
const database = createDatabase(databaseConfigFromEnvironment(env))

try {
  await runMigrations(database)
  const summary = await seedSyntheticData(database, { nodeEnv: env.NODE_ENV })
  console.log(`Seed complete: ${JSON.stringify(summary)}`)
} catch (error) {
  console.error(
    `Seed failed: ${error instanceof Error ? error.message : String(error)}`,
  )
  process.exitCode = 1
} finally {
  await database.close()
}
