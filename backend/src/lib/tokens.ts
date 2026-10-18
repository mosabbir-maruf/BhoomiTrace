import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

import { TOKEN_BYTES } from '../config/constants.js'

/**
 * Opaque token generation, hashing, and comparison.
 *
 * Session and CSRF tokens are 256-bit random values. They are stored only as a
 * SHA-256 digest, because the token itself already carries full entropy: unlike
 * a password, there is no small guessable space to attack, so a deliberately
 * slow KDF would add latency to every request without adding security. Passwords
 * use Argon2id instead — see `./password.js`.
 */

/** Generates a URL-safe, cryptographically random token. */
export function generateToken(byteLength: number = TOKEN_BYTES): string {
  return randomBytes(byteLength).toString('base64url')
}

/** Hex-encoded SHA-256 digest, used for token storage and file checksums. */
export function sha256Hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

/**
 * Compares two strings without leaking their contents through timing.
 *
 * Returns `false` for length mismatches rather than throwing, so a malformed
 * token is just an invalid token.
 */
export function timingSafeEqualStrings(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

/** A generated secret together with the digest that is safe to store. */
export interface IssuedToken {
  /** Returned to the caller once. Never persisted. */
  token: string
  /** Persisted. */
  tokenHash: string
}

export function issueToken(byteLength: number = TOKEN_BYTES): IssuedToken {
  const token = generateToken(byteLength)
  return { token, tokenHash: sha256Hex(token) }
}
