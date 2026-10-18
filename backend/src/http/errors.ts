import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod'

import { isAppError } from '../lib/errors.js'

/**
 * The one error response shape used by every endpoint:
 *
 * ```json
 * { "error": { "code": "not_found", "message": "...", "requestId": "..." } }
 * ```
 *
 * `requestId` is the correlation key for the log line that holds the real
 * detail. Nothing internal — no SQL text, no stack trace, no file path, no
 * connection string, no session value — is ever placed in the payload.
 */

export interface ErrorEnvelope {
  error: {
    code: string
    message: string
    requestId: string
    details?: unknown
  }
}

/** PostgreSQL error codes worth translating into an honest client error. */
const PG_UNIQUE_VIOLATION = '23505'
const PG_FOREIGN_KEY_VIOLATION = '23503'
const PG_CHECK_VIOLATION = '23514'
const PG_NOT_NULL_VIOLATION = '23502'

/**
 * Stable codes for requests the framework itself refused.
 *
 * Deliberately a small fixed vocabulary rather than whatever code the framework
 * happened to attach, so a caller can branch on it without tracking Fastify's
 * internals. Anything unlisted falls back to `request_error`.
 */
const FRAMEWORK_ERROR_CODES: Readonly<Record<number, string>> = {
  400: 'bad_request',
  401: 'unauthenticated',
  403: 'forbidden',
  404: 'not_found',
  405: 'method_not_allowed',
  408: 'request_timeout',
  413: 'payload_too_large',
  415: 'unsupported_media_type',
  429: 'rate_limited',
}

/**
 * Finds a PostgreSQL error code anywhere in an error's `cause` chain.
 *
 * Drizzle wraps driver errors, so the code is usually one or two levels down.
 * The code itself is safe to act on; the accompanying message is not, because
 * it names tables and constraints.
 */
function findPostgresErrorCode(error: unknown): string | undefined {
  let current: unknown = error
  for (let depth = 0; depth < 6; depth += 1) {
    if (typeof current !== 'object' || current === null) return undefined
    const code = (current as { code?: unknown }).code
    if (typeof code === 'string' && /^\d{5}$/.test(code)) return code
    current = (current as { cause?: unknown }).cause
  }
  return undefined
}

/** Reads a numeric `statusCode` from a thrown value, if it has one. */
function readStatusCode(error: unknown): number | undefined {
  if (typeof error === 'object' && error !== null && 'statusCode' in error) {
    const value = (error as { statusCode?: unknown }).statusCode
    if (typeof value === 'number' && value >= 400 && value <= 599) return value
  }
  return undefined
}

export function registerErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    sendError(reply, request, error)
  })

  app.setNotFoundHandler((request, reply) => {
    return reply.code(404).send({
      error: {
        code: 'not_found',
        message: 'No route matches this request.',
        requestId: request.id,
      },
    } satisfies ErrorEnvelope)
  })
}

function sendError(
  reply: FastifyReply,
  request: FastifyRequest,
  error: unknown,
): FastifyReply {
  const envelope = (code: string, message: string, details?: unknown): ErrorEnvelope => ({
    error: {
      code,
      message,
      requestId: request.id,
      ...(details === undefined ? {} : { details }),
    },
  })

  // --- Expected application failures -------------------------------------
  if (isAppError(error)) {
    if (error.statusCode >= 500) {
      request.log.error({ err: error }, 'request failed')
    } else {
      request.log.info({ code: error.code }, 'request rejected')
    }
    return reply
      .code(error.statusCode)
      .send(envelope(error.code, error.message, error.details))
  }

  // --- Request schema validation ----------------------------------------
  if (hasZodFastifySchemaValidationErrors(error)) {
    const details = error.validation.map((issue) => ({
      path: issue.instancePath,
      message: issue.message,
    }))
    request.log.info({ issues: details }, 'request validation failed')
    return reply
      .code(422)
      .send(envelope('validation_failed', 'The request failed validation.', details))
  }

  // --- Database constraint failures -------------------------------------
  const pgCode = findPostgresErrorCode(error)
  if (pgCode !== undefined) {
    request.log.info({ pgCode }, 'database rejected the write')
    switch (pgCode) {
      case PG_UNIQUE_VIOLATION:
        return reply
          .code(409)
          .send(
            envelope(
              'conflict',
              'A record with those details already exists.',
            ),
          )
      case PG_FOREIGN_KEY_VIOLATION:
        return reply
          .code(409)
          .send(
            envelope(
              'reference_conflict',
              'That change would remove or disconnect a record that other data still depends on.',
            ),
          )
      case PG_CHECK_VIOLATION:
      case PG_NOT_NULL_VIOLATION:
        return reply
          .code(422)
          .send(
            envelope(
              'constraint_violation',
              'The submitted values are not valid for this record.',
            ),
          )
      default:
        break
    }
  }

  // --- Known Fastify-level errors (payload limits, content types, ...) ---
  const statusCode = readStatusCode(error)
  if (statusCode !== undefined && statusCode < 500) {
    // The framework's own code (`FST_ERR_CTP_INVALID_MEDIA_TYPE` and friends)
    // would make this API's contract depend on a Fastify version, so the status
    // decides the code a caller sees and the raw code is only logged.
    const frameworkCode =
      typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code?: unknown }).code)
        : undefined
    const code = FRAMEWORK_ERROR_CODES[statusCode] ?? 'request_error'
    request.log.info({ statusCode, frameworkCode }, 'request rejected')
    return reply
      .code(statusCode)
      .send(
        envelope(
          code,
          error instanceof Error ? error.message : 'The request could not be processed.',
        ),
      )
  }

  // --- Anything else is an internal fault -------------------------------
  request.log.error({ err: error }, 'unhandled request error')
  return reply
    .code(500)
    .send(
      envelope('internal_error', 'An unexpected error occurred.'),
    )
}
