import { hostname } from 'node:os'

import pino from 'pino'

import { VALIDATION_RULES_VERSION } from '../config/constants.js'
import {
  describeEnvironment,
  loadEnvironment,
  workerConfigurationNotes,
} from '../config/env.js'
import { loadEnvFile } from '../config/load-env.js'
import { loggerOptions } from '../config/logging.js'
import { createDatabase, databaseConfigFromEnvironment } from '../db/client.js'
import { createExtractionProvider, describeProvider } from '../extraction/registry.js'
import { ExtractionWorker } from './runner.js'

/**
 * Process entry point for the extraction worker: `npm run worker`.
 *
 * It is deliberately a second process rather than a background task inside the
 * API server. Extraction is slow and talks to an outside service; running it in
 * the request process would couple a user's response time to a third party's
 * latency, and would mean a restart of the API abandoned work in flight. Here,
 * an abandoned job is recoverable: the lease expires and another worker picks it
 * up.
 *
 * The process refuses to start on a provider it cannot use, and says loudly if
 * it is about to run the synthetic reader in production, because "the worker is
 * running" and "something is actually reading documents" are different claims
 * and an operator needs to be able to tell them apart.
 */

loadEnvFile()

const env = loadEnvironment()
const log = pino(loggerOptions(env))
const database = createDatabase(databaseConfigFromEnvironment(env))
const provider = createExtractionProvider(env)
const providerDetails = describeProvider(provider)

log.info(
  {
    config: describeEnvironment(env),
    provider: providerDetails,
    rulesVersion: VALIDATION_RULES_VERSION,
  },
  'starting extraction worker',
)

if (!provider.isConfigured()) {
  // A named external reader without its credential is refused by the
  // environment schema, so reaching this means a custom provider was wired in
  // without the configuration it needs. Failing at startup is better than
  // failing every job one retry at a time.
  log.error(
    { provider: providerDetails },
    'extraction provider is not configured; refusing to start',
  )
  await database.close()
  process.exit(1)
}

if (env.NODE_ENV === 'production' && provider.name === 'mock') {
  log.error(
    { provider: providerDetails },
    'the mock provider is a test double, not a reader: it marks every field it has no fixture for as unclear, and its readings do not come from the document. Set EXTRACTION_PROVIDER and the matching credential before running a production worker.',
  )
}

for (const note of workerConfigurationNotes(env)) {
  log.warn({ note }, 'worker configuration note')
}

const worker = new ExtractionWorker({
  database,
  provider,
  rulesVersion: VALIDATION_RULES_VERSION,
  // Identifies this process in leases and audit rows, so a stuck lease can be
  // traced back to the process that took it.
  workerId: `${hostname()}:${process.pid}`,
  leaseSeconds: env.WORKER_LEASE_SECONDS,
  maxAttempts: env.WORKER_MAX_ATTEMPTS,
  retryBackoffSeconds: env.WORKER_RETRY_BACKOFF_SECONDS,
  pollIntervalMs: env.WORKER_POLL_INTERVAL_MS,
  // Readers are handed the real document, loaded from private storage.
  uploadDir: env.UPLOAD_DIR,
  maxContentBytes: env.EXTRACTION_MAX_CONTENT_BYTES,
  log,
})

let stopping = false

/** Stops taking new work, finishes the job in flight, then releases the pool. */
function stop(reason: string): void {
  if (stopping) return
  stopping = true
  log.info({ reason }, 'stopping after the job in flight')
  worker.requestStop()
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    stop(signal)
  })
}

process.on('unhandledRejection', (reason) => {
  log.error({ err: reason }, 'unhandled rejection')
  stop('unhandledRejection')
})

process.on('uncaughtException', (error) => {
  log.error({ err: error }, 'uncaught exception')
  stop('uncaughtException')
})

const databaseHealth = await database.ping()
if (!databaseHealth.ok) {
  log.error('database is not reachable; jobs cannot be claimed')
  await database.close()
  process.exit(1)
}

try {
  const processed = await worker.run()
  log.info({ processed }, 'worker stopped')
} catch (error) {
  // `run` only rejects on a failure it cannot attribute to a job, which means
  // the claim path itself is broken. Exiting non-zero lets a supervisor restart
  // the process.
  log.error({ err: error }, 'worker loop failed')
  process.exitCode = 1
} finally {
  await database.close()
}
