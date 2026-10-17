import { randomUUID } from 'node:crypto'

import Fastify, { type FastifyInstance } from 'fastify'

import { SERVICE_NAME, SERVICE_VERSION } from './config/constants.js'
import type { Environment } from './config/env.js'
import type { Database } from './db/client.js'
import { healthRoutes } from './routes/health.js'

declare module 'fastify' {
  interface FastifyInstance {
    /** Pooled database client, injected so routes never construct their own. */
    database: Database
  }
}

export interface BuildAppOptions {
  env: Environment
  database: Database
}

/** Reads an HTTP status from a thrown error, defaulting to 500. */
function readStatusCode(error: unknown): number {
  if (typeof error === 'object' && error !== null && 'statusCode' in error) {
    const value = (error as { statusCode?: unknown }).statusCode
    if (typeof value === 'number' && value >= 400 && value <= 599) return value
  }
  return 500
}

/**
 * Builds the Fastify application.
 *
 * Constructing the app is separated from listening so that tests can use
 * `app.inject()` without binding a socket.
 */
export function buildApp(options: BuildAppOptions): FastifyInstance {
  const app = Fastify({
    logger: {
      level: options.env.LOG_LEVEL,
      base: {
        service: SERVICE_NAME,
        version: SERVICE_VERSION,
        env: options.env.NODE_ENV,
      },
      // Never write credentials or session material to logs.
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.headers["x-api-key"]',
          'res.headers["set-cookie"]',
          'connectionString',
          'databaseUrl',
        ],
        censor: '[redacted]',
      },
    },
    genReqId: () => randomUUID(),
    requestIdHeader: 'x-request-id',
    // Proxy headers are not trusted until a real reverse proxy is configured.
    trustProxy: false,
  })

  app.decorate('database', options.database)

  // Normalised error responses: internals stay in the logs, not the payload.
  app.setErrorHandler((error: unknown, request, reply) => {
    const statusCode = readStatusCode(error)
    const isServerError = statusCode >= 500

    if (isServerError) {
      request.log.error({ err: error }, 'request failed')
    } else {
      request.log.info({ err: error }, 'request rejected')
    }

    return reply.code(statusCode).send({
      error: isServerError
        ? 'InternalServerError'
        : error instanceof Error
          ? error.name
          : 'RequestError',
      message: isServerError
        ? 'An unexpected error occurred.'
        : error instanceof Error
          ? error.message
          : 'The request could not be processed.',
      requestId: request.id,
    })
  })

  app.register(healthRoutes)

  return app
}
