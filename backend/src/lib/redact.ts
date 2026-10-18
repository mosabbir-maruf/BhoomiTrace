/**
 * Redaction helpers for anything that is persisted or logged.
 *
 * Audit rows and error messages are read by people, stored for a long time, and
 * copied into logs and reports, so they are a likely place for a secret to
 * escape. These helpers make the safe thing the default.
 */

/** Keys whose values are never written to an audit row or a log line. */
const SENSITIVE_KEY_PATTERN =
  /(pass(word)?|secret|token|cookie|authorization|api[_-]?key|credential|session|csrf|signature)/i

/** Maximum length of a string kept in an audit detail field. */
const MAX_DETAIL_STRING_LENGTH = 512

/**
 * Returns a copy of `value` with sensitive keys replaced by a placeholder and
 * long strings truncated.
 *
 * Applied recursively to plain objects and arrays. Anything that is not
 * JSON-representable is stringified first, so a stray `Error` or `Buffer`
 * cannot smuggle its contents into an audit row.
 */
export function redactForAudit(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[truncated]'

  if (value === null || value === undefined) return value

  if (typeof value === 'string') {
    return value.length > MAX_DETAIL_STRING_LENGTH
      ? `${value.slice(0, MAX_DETAIL_STRING_LENGTH)}…`
      : value
  }

  if (typeof value === 'number' || typeof value === 'boolean') return value

  if (typeof value === 'bigint') return value.toString()

  if (Array.isArray(value)) {
    return value.slice(0, 50).map((entry) => redactForAudit(entry, depth + 1))
  }

  if (value instanceof Date) return value.toISOString()

  if (typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      result[key] = SENSITIVE_KEY_PATTERN.test(key)
        ? '[redacted]'
        : redactForAudit(entry, depth + 1)
    }
    return result
  }

  return String(value)
}

/**
 * Produces a short, safe failure reason for storage.
 *
 * Internal error text can contain connection strings, file paths, or document
 * fragments. Only the error's class name and a redacted, truncated message are
 * kept, which is enough to triage without leaking.
 */
export function safeErrorSummary(error: unknown): string {
  if (error instanceof Error) {
    const name = error.name || 'Error'
    const message = error.message
      .replace(/postgres(ql)?:\/\/\S+/gi, '[redacted-connection-string]')
      .replace(/(password|token|secret|api[_-]?key)=[^\s&]+/gi, '$1=[redacted]')
      .slice(0, 300)
    return `${name}: ${message}`
  }
  return 'UnknownError'
}
