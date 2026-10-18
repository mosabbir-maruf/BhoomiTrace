import type { FastifyInstance } from 'fastify'

import { SERVICE_NAME, SERVICE_VERSION } from '../config/constants.js'

function uptimeSeconds(): number {
  return Number(process.uptime().toFixed(3))
}

/**
 * Health endpoints.
 *
 * - `GET /health/live` — process liveness only. Never touches the database, so
 *   it stays cheap for a container or load-balancer probe.
 * - `GET /health` — readiness. Verifies database connectivity and returns 503
 *   when the dependency is unavailable.
 *
 * Database error messages are logged but never returned, to avoid exposing
 * internal details on an unauthenticated endpoint.
 */
export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health/live', { logLevel: 'warn' }, async () => ({
    status: 'ok' as const,
    service: SERVICE_NAME,
    version: SERVICE_VERSION,
    uptimeSeconds: uptimeSeconds(),
  }))

  app.get('/health', async (request, reply) => {
    const database = await app.database.ping()

    if (!database.ok) {
      request.log.error(
        { databaseError: database.error },
        'database health check failed',
      )
    }

    return reply.code(database.ok ? 200 : 503).send({
      status: database.ok ? ('ok' as const) : ('unavailable' as const),
      service: SERVICE_NAME,
      version: SERVICE_VERSION,
      uptimeSeconds: uptimeSeconds(),
      checks: {
        database: {
          status: database.ok ? ('up' as const) : ('down' as const),
          latencyMs: database.latencyMs,
        },
      },
    })
  })
}
