import { createDatabase, type Database } from '../../src/db/client.js'
import { runMigrations } from '../../src/db/migrate.js'

/**
 * Shared integration-test database.
 *
 * The URL must name a database ending in `_test`; the guard below makes it
 * impossible to point the integration suite at a development or production
 * database and mutate real data by accident.
 */
const DEFAULT_TEST_DATABASE_URL =
  'postgres://bhoomitrace:bhoomitrace@127.0.0.1:5433/bhoomitrace_test'

function assertIsTestDatabase(connectionString: string): void {
  const databaseName = new URL(connectionString).pathname.replace(/^\//, '')
  if (!databaseName.endsWith('_test')) {
    throw new Error(
      `Refusing to run integration tests against database "${databaseName}": ` +
        'the database name must end with "_test".',
    )
  }
}

let initialization: Promise<Database> | undefined
let instance: Database | undefined

/** Creates the pool and applies migrations exactly once per worker process. */
export function initializeTestDatabase(): Promise<Database> {
  initialization ??= (async () => {
    const connectionString =
      process.env['TEST_DATABASE_URL'] ?? DEFAULT_TEST_DATABASE_URL
    assertIsTestDatabase(connectionString)

    const database = createDatabase({
      connectionString,
      poolMax: 4,
      connectionTimeoutMs: 5_000,
      applicationName: 'bhoomitrace-backend-test',
    })

    await runMigrations(database)
    instance = database
    return database
  })()

  return initialization
}

/** Releases the pool. Safe to call when nothing was initialized. */
export async function closeTestDatabase(): Promise<void> {
  if (!instance) return
  const database = instance
  instance = undefined
  initialization = undefined
  await database.close()
}

/**
 * Flattens an error and its `cause` chain into one string.
 *
 * Drizzle wraps driver errors, so the constraint name a test asserts on may sit
 * one or more levels down the chain.
 */
export function errorChainMessage(error: unknown): string {
  const parts: string[] = []
  let current: unknown = error

  for (let depth = 0; depth < 6; depth += 1) {
    if (current instanceof Error) {
      parts.push(current.message)
      current = current.cause
      continue
    }
    if (current !== undefined && current !== null) {
      parts.push(String(current))
    }
    break
  }

  return parts.join(' | ')
}

/** Returns the first row of a statement result, failing when there is none. */
export async function firstOrThrow<T>(rows: readonly T[]): Promise<T> {
  const [row] = rows
  if (row === undefined) {
    throw new Error('Expected the statement to return a row.')
  }
  return row
}

/** Awaits an operation that must fail, returning the combined error message. */
export async function expectRejection(
  operation: () => Promise<unknown>,
  expectedFragment?: string,
): Promise<string> {
  try {
    await operation()
  } catch (error) {
    const message = errorChainMessage(error)
    if (expectedFragment !== undefined) {
      if (!message.includes(expectedFragment)) {
        throw new Error(
          `Expected the failure to mention "${expectedFragment}", but it was: ${message}`,
        )
      }
    }
    return message
  }

  throw new Error('Expected the operation to fail, but it succeeded.')
}
