import { sql } from 'drizzle-orm'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'

import type { Environment } from '../config/env.js'
import * as schema from './schema/index.js'

/** Connection settings for the application database. */
export interface DatabaseConfig {
  connectionString: string
  /** Maximum number of pooled connections. */
  poolMax?: number
  /** Milliseconds to wait for a new connection before failing. */
  connectionTimeoutMs?: number
  /** Reported to PostgreSQL, useful when inspecting `pg_stat_activity`. */
  applicationName?: string
}

/** Result of a liveness probe against the database. */
export interface DatabaseHealth {
  ok: boolean
  latencyMs: number
  error?: string
}

export interface Database {
  readonly pool: Pool
  readonly orm: NodePgDatabase<typeof schema>
  ping(): Promise<DatabaseHealth>
  close(): Promise<void>
}

/** Builds connection settings from validated application configuration. */
export function databaseConfigFromEnvironment(env: Environment): DatabaseConfig {
  return {
    connectionString: env.DATABASE_URL,
    poolMax: env.DATABASE_POOL_MAX,
    connectionTimeoutMs: env.DATABASE_CONNECT_TIMEOUT_MS,
    applicationName: 'bhoomitrace-backend',
  }
}

/**
 * Creates the pooled database client.
 *
 * The pool owns connection lifecycle; `close()` must be awaited during shutdown
 * so that in-flight queries can finish and sockets are released.
 */
export function createDatabase(config: DatabaseConfig): Database {
  const pool = new Pool({
    connectionString: config.connectionString,
    max: config.poolMax ?? 10,
    connectionTimeoutMillis: config.connectionTimeoutMs ?? 5_000,
    idleTimeoutMillis: 30_000,
    application_name: config.applicationName ?? 'bhoomitrace-backend',
  })

  // An idle client error would otherwise be an unhandled 'error' event and
  // terminate the process. Log-and-continue: the pool discards the client and
  // the next query obtains a fresh connection.
  pool.on('error', (error) => {
    console.error(
      JSON.stringify({
        level: 'error',
        msg: 'idle postgres client error',
        error: error.message,
      }),
    )
  })

  const orm = drizzle(pool, { schema })

  return {
    pool,
    orm,
    async ping(): Promise<DatabaseHealth> {
      const startedAt = performance.now()
      try {
        await orm.execute(sql`select 1`)
        return {
          ok: true,
          latencyMs: Number((performance.now() - startedAt).toFixed(2)),
        }
      } catch (error) {
        return {
          ok: false,
          latencyMs: Number((performance.now() - startedAt).toFixed(2)),
          error: error instanceof Error ? error.message : String(error),
        }
      }
    },
    async close(): Promise<void> {
      await pool.end()
    },
  }
}
