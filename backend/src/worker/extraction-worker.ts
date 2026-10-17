import { randomUUID } from 'node:crypto'

import { pino } from 'pino'

import { loggerOptions } from '../config/logging.js'
import { VALIDATION_RULES_VERSION } from '../config/constants.js'
import { describeEnvironment, loadEnvironment } from '../config/env.js'
import { loadEnvFile } from '../config/load-env.js'
import { createDatabase, databaseConfigFromEnvironment } from '../db/client.js'
import { createExtractionProvider } from '../extraction/registry.js'
import { ExtractionWorker } from './runner.js'

/**
 * Worker entry point: `npm run worker`.
 *
 * Runs the durable processing queue. Deliberately a separate process from the
 * API server so that a long extraction never occupies a request handler, and so
 * that workers can be scaled or restarted without touching the API.
 *
 * The provider comes from validated configuration. With the default
 * `EXTRACTION_PROVIDER=mock` this runs with no credentials and no network
 * access, which is how the whole pipeline is exercised in development and tests.
 */

loadEnvFile()

const env = loadEnvironment()
const log = pino(loggerOptions(env))

const database = createDatabase(databaseConfigFromEnvironment(env))
const provider = createExtractionProvider(env)

const workerId = `worker-${randomUUID().slice(0, 8)}`

const worker = new ExtractionWorker({
  database,
  provider,
  rulesVersion: VALIDATION_RULES_VERSION,
  workerId,
  leaseSeconds: env.WORKER_LEASE_SECONDS,
  maxAttempts: env.WORKER_MAX_ATTEMPTS,
  retryBackoffSeconds: env.WORKER_RETRY_BACKOFF_SECONDS,
  pollIntervalMs: env.WORKER_POLL_INTERVAL_MS,
  log,
})

log.info(
  {
    workerId,
    provider: provider.name,
    providerConfigured: provider.isConfigured(),
    leaseSeconds: env.WORKER_LEASE_SECONDS,
    maxAttempts: env.WORKER_MAX_ATTEMPTS,
    pollIntervalMs: env.WORKER_POLL_INTERVAL_MS,
    config: describeEnvironment(env),
  },
  'extraction worker starting',
)

let shuttingDown = false

/** Stops claiming work, lets the in-flight job finish, then closes the pool. */
async function shutdown(reason: string): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true

  log.info({ reason, workerId }, 'extraction worker shutting down')
  worker.requestStop()

  // The runner returns once the current job (if any) has finished.
  await running
  await database.close()
  log.info({ workerId }, 'extraction worker stopped')
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void shutdown(signal)
  })
}

const running = worker.run()

running
  .then((processed) => {
    log.info({ processed, workerId }, 'extraction worker loop ended')
  })
  .catch((error: unknown) => {
    log.error({ err: error, workerId }, 'extraction worker failed')
    process.exitCode = 1
  })
