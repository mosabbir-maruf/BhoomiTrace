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
