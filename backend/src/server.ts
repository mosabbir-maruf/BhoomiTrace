import { buildApp } from './app.js'
import { describeEnvironment, loadEnvironment } from './config/env.js'
import { loadEnvFile } from './config/load-env.js'
import { createDatabase, databaseConfigFromEnvironment } from './db/client.js'

/** Process entry point: `npm run dev` / `npm start`. */

loadEnvFile()

const env = loadEnvironment()
const database = createDatabase(databaseConfigFromEnvironment(env))
const app = buildApp({ env, database })

app.log.info({ config: describeEnvironment(env) }, 'starting bhoomitrace backend')

let shuttingDown = false

/** Stops accepting connections, drains in-flight work, then releases the pool. */
async function shutdown(reason: string): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true

  app.log.info({ reason }, 'shutting down')
  try {
    await app.close()
    await database.close()
    app.log.info('shutdown complete')
  } catch (error) {
    app.log.error({ err: error }, 'error during shutdown')
    process.exitCode = 1
  }
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void shutdown(signal)
  })
}

process.on('unhandledRejection', (reason) => {
  app.log.error({ err: reason }, 'unhandled rejection')
  void shutdown('unhandledRejection')
})

process.on('uncaughtException', (error) => {
  app.log.error({ err: error }, 'uncaught exception')
  void shutdown('uncaughtException')
})

try {
  await app.listen({ host: env.HOST, port: env.PORT })
} catch (error) {
  app.log.error({ err: error }, 'failed to start server')
  await database.close()
  process.exit(1)
}

const databaseHealth = await database.ping()
if (!databaseHealth.ok) {
  app.log.warn(
    'database is not reachable at startup; /health will report unavailable',
  )
}
