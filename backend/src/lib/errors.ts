/**
 * Application error types.
 *
 * Every expected failure is represented by one of these instead of a bare
 * `Error`, so that the HTTP layer can map it to a status code and a stable
 * machine-readable code without inspecting message text. Anything that is *not*
 * an `AppError` is treated as an internal fault: the caller gets a generic
 * message and the detail stays in the logs.
 */

export type ErrorDetails = Readonly<Record<string, unknown>> | readonly unknown[]

/** Base class for failures the API is allowed to describe to a caller. */
export class AppError extends Error {
  override readonly name: string = 'AppError'

  constructor(
    readonly statusCode: number,
    /** Stable, machine-readable identifier. Never a sentence. */
    readonly code: string,
    message: string,
    readonly details?: ErrorDetails,
  ) {
    super(message)
  }
}

export class BadRequestError extends AppError {
  override readonly name = 'BadRequestError'

  constructor(message = 'The request could not be understood.', details?: ErrorDetails) {
    super(400, 'bad_request', message, details)
  }
}

export class ValidationError extends AppError {
  override readonly name = 'ValidationError'

  constructor(
    message = 'The request failed validation.',
    details?: ErrorDetails,
  ) {
    super(422, 'validation_failed', message, details)
  }
}

export class UnauthorizedError extends AppError {
  override readonly name = 'UnauthorizedError'

  constructor(message = 'Authentication is required.', details?: ErrorDetails) {
    super(401, 'unauthenticated', message, details)
  }
}

export class ForbiddenError extends AppError {
  override readonly name = 'ForbiddenError'

  /**
   * Used both for "your role may not do this" and for "this record is not
   * yours". Callers see one message either way, so that probing an identifier
   * cannot distinguish "not found" from "not yours".
   */
  constructor(message = 'You do not have access to this resource.', details?: ErrorDetails) {
    super(403, 'forbidden', message, details)
  }
}

export class NotFoundError extends AppError {
  override readonly name = 'NotFoundError'

  constructor(message = 'The requested resource was not found.', details?: ErrorDetails) {
    super(404, 'not_found', message, details)
  }
}

export class ConflictError extends AppError {
  override readonly name = 'ConflictError'

  constructor(message = 'The request conflicts with the current state.', details?: ErrorDetails) {
    super(409, 'conflict', message, details)
  }
}

/**
 * Raised when an idempotency key is reused for a different request.
 *
 * A key identifies *one* unit of work. Returning whatever job already exists
 * under a key would answer a question the caller did not ask — and, when the key
 * belongs to somebody else, would leak their job. A distinct code lets a client
 * tell "you already asked for this" apart from "you asked for something else
 * with the same key", which the plain `conflict` code cannot express.
 */
export class IdempotencyKeyReusedError extends AppError {
  override readonly name = 'IdempotencyKeyReusedError'

  constructor(
    message = 'That idempotency key was already used for a different request.',
    details?: ErrorDetails,
  ) {
    super(409, 'idempotency_key_reused', message, details)
  }
}

/**
 * Raised when a worker tries to write for a job it no longer holds.
 *
 * Two workers must never both produce a job's side effects. Every write a worker
 * makes is fenced on the lease it claimed, so a worker whose lease expired and
 * was reclaimed by somebody else fails this check and rolls back rather than
 * committing a duplicate result.
 */
export class JobLeaseLostError extends AppError {
  override readonly name = 'JobLeaseLostError'

  constructor(
    message = 'This job is no longer held by this worker, so no result was recorded.',
    details?: ErrorDetails,
  ) {
    super(409, 'job_lease_lost', message, details)
  }
}

/** Raised when a state machine refuses a move from the state a record is in. */
export class InvalidTransitionError extends AppError {
  override readonly name = 'InvalidTransitionError'

  constructor(
    message = 'That transition is not allowed from the current state.',
    details?: ErrorDetails,
  ) {
    super(409, 'invalid_transition', message, details)
  }
}

/** Raised when an optimistic-concurrency token no longer matches. */
export class ConcurrencyError extends AppError {
  override readonly name = 'ConcurrencyError'

  constructor(
    message = 'This record was changed by somebody else. Reload it and try again.',
    details?: ErrorDetails,
  ) {
    super(409, 'concurrent_modification', message, details)
  }
}

export class PayloadTooLargeError extends AppError {
  override readonly name = 'PayloadTooLargeError'

  constructor(message = 'The payload is too large.', details?: ErrorDetails) {
    super(413, 'payload_too_large', message, details)
  }
}

export class UnsupportedMediaTypeError extends AppError {
  override readonly name = 'UnsupportedMediaTypeError'

  constructor(message = 'The media type is not supported.', details?: ErrorDetails) {
    super(415, 'unsupported_media_type', message, details)
  }
}

export class TooManyRequestsError extends AppError {
  override readonly name = 'TooManyRequestsError'

  constructor(message = 'Too many requests. Try again later.', details?: ErrorDetails) {
    super(429, 'rate_limited', message, details)
  }
}

export class ServiceUnavailableError extends AppError {
  override readonly name = 'ServiceUnavailableError'

  constructor(message = 'The service is temporarily unavailable.', details?: ErrorDetails) {
    super(503, 'service_unavailable', message, details)
  }
}

/** Raised when a provider is asked to do something it is not configured for. */
export class ProviderUnavailableError extends AppError {
  override readonly name = 'ProviderUnavailableError'

  constructor(message = 'The extraction provider is unavailable.', details?: ErrorDetails) {
    super(503, 'provider_unavailable', message, details)
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError
}
