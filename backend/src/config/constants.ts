/** Fixed service identity, used in logs and health responses. */
export const SERVICE_NAME = 'bhoomitrace-backend'

/** Kept in sync with the `version` field in package.json. */
export const SERVICE_VERSION = '0.1.0'

/** Base path for every versioned API route. */
export const API_PREFIX = '/api/v1'

/**
 * Name of the HTTP-only session cookie.
 *
 * The `__Host-` prefix is deliberately not used: it requires `Secure`, which is
 * false on plain-HTTP local development. The name is fixed so that cookie
 * clearing during logout always matches the cookie that was set.
 */
export const SESSION_COOKIE_NAME = 'bt_session'

/**
 * Name of the readable CSRF cookie.
 *
 * It is intentionally *not* HTTP-only, because the browser client must read it
 * to echo the value back in a header. The value is worthless on its own: it is
 * only accepted when it matches a hash bound to the caller's session.
 */
export const CSRF_COOKIE_NAME = 'bt_csrf'

/** Header a client uses to echo the CSRF token on state-changing requests. */
export const CSRF_HEADER_NAME = 'x-csrf-token'

/** Version identifier of the deterministic validation rule set. */
export const VALIDATION_RULES_VERSION = 'phase2.1'

/**
 * Argon2id parameters.
 *
 * These are the OWASP-recommended baseline for Argon2id: 19 MiB of memory, two
 * iterations, one lane of parallelism. They are stated explicitly rather than
 * left to a library default so that a dependency upgrade cannot silently
 * weaken password hashing; the values are recorded in the README and asserted
 * by a test.
 */
export const ARGON2_PARAMETERS = {
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
} as const

/** Minimum and maximum accepted password lengths. */
export const PASSWORD_MIN_LENGTH = 12
export const PASSWORD_MAX_LENGTH = 128

/**
 * Argon2 algorithm selector.
 *
 * `@node-rs/argon2` declares `Algorithm` as an ambient `const enum`, which the
 * project's `verbatimModuleSyntax` setting forbids reading from, and which does
 * not exist as a runtime object to import. The value is therefore written out
 * literally. A test asserts that produced hashes carry the `$argon2id$` marker,
 * so if these numbers ever stopped meaning "Argon2id" the suite would fail
 * rather than quietly hashing with a weaker variant.
 */
export const ARGON2_ALGORITHM_ID = 2

/** Byte length of opaque session and CSRF tokens (256 bits). */
export const TOKEN_BYTES = 32
