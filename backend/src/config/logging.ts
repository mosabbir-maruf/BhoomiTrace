import type { LoggerOptions } from 'pino'

import type { Environment } from './env.js'

/**
 * Shared logging configuration.
 *
 * The API server and the worker both log structurally, and both use the same
 * redaction list, so a secret cannot leak through one process and not the other.
 *
 * Redaction is by path, applied by pino before serialisation, which means a
 * redacted value is never even formatted into the output. The list covers the
 * places a credential realistically turns up: request headers, cookies, and the
 * auth-shaped field names that appear in our own objects and in provider
 * payloads.
 *
 * `LOG_LEVEL=silent` is honoured, which is what the integration tests use so
 * that a passing run does not print a wall of traffic.
 */

/** Field names that must never be logged, wherever they appear. */
export const REDACTED_LOG_PATHS: readonly string[] = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-csrf-token"]',
  'res.headers["set-cookie"]',
  'password',
  'currentPassword',
  'newPassword',
  'passwordHash',
  'password_hash',
  'token',
  'tokenHash',
  'token_hash',
  'sessionToken',
  'csrfToken',
  'csrf_token_hash',
  'apiKey',
  'api_key',
  'GEMINI_API_KEY',
  'GROQ_API_KEY',
  'authorization',
  'cookie',
  'secret',
  // Common nesting shapes in our own payloads and in provider responses.
  '*.password',
  '*.passwordHash',
  '*.token',
  '*.tokenHash',
  '*.sessionToken',
  '*.csrfToken',
  '*.apiKey',
  '*.secret',
  '*.authorization',
  '*.cookie',
]

export function loggerOptions(env: Environment): LoggerOptions {
  return {
    level: env.LOG_LEVEL,
    redact: { paths: [...REDACTED_LOG_PATHS], censor: '[redacted]' },
    base: { service: 'bhoomitrace-backend', env: env.NODE_ENV },
    timestamp: true,
    formatters: {
      level: (label) => ({ level: label }),
    },
  }
}
