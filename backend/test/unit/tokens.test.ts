import { describe, expect, it } from 'vitest'

import { TOKEN_BYTES } from '../../src/config/constants.js'
import {
  generateToken,
  issueToken,
  sha256Hex,
  timingSafeEqualStrings,
} from '../../src/lib/tokens.js'

/**
 * Opaque token generation and comparison.
 *
 * Session and CSRF tokens are the only thing standing between a request and
 * somebody else's account, so their length and randomness are asserted rather
 * than assumed.
 */

describe('generateToken', () => {
  it('produces a 256-bit URL-safe token', () => {
    const token = generateToken()

    // 32 bytes as base64url: ceil(32 / 3) * 4 = 43 characters, no padding.
    expect(TOKEN_BYTES).toBe(32)
    expect(token).toHaveLength(43)
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('never repeats across a large sample', () => {
    const tokens = new Set<string>()
    for (let index = 0; index < 500; index += 1) tokens.add(generateToken())

    expect(tokens.size).toBe(500)
  })

  it('honours an explicit byte length', () => {
    expect(generateToken(16)).toHaveLength(22)
  })
})

describe('sha256Hex', () => {
  it('matches the published digests for known inputs', () => {
    // Digests from FIPS 180-4 / the canonical test vectors.
    expect(sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    )
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })

  it('hashes buffers and strings of the same bytes identically', () => {
    const buffer = Buffer.from('same bytes', 'utf8')
    expect(sha256Hex(buffer)).toBe(sha256Hex('same bytes'))
  })

  it('always returns 64 lowercase hex characters', () => {
    expect(sha256Hex(generateToken())).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('issueToken', () => {
  it('returns a token and the digest that is safe to store', () => {
    const issued = issueToken()

    expect(issued.token).toHaveLength(43)
    expect(issued.tokenHash).toBe(sha256Hex(issued.token))
    expect(issued.tokenHash).not.toContain(issued.token)
  })
})

describe('timingSafeEqualStrings', () => {
  it('accepts equal strings and rejects different ones', () => {
    expect(timingSafeEqualStrings('token-value', 'token-value')).toBe(true)
    expect(timingSafeEqualStrings('token-value', 'token-valuf')).toBe(false)
    expect(timingSafeEqualStrings('', '')).toBe(true)
  })

  it('returns false for differing lengths instead of throwing', () => {
    // `crypto.timingSafeEqual` throws on a length mismatch, which would turn a
    // malformed token into a 500 rather than a rejection.
    expect(() => timingSafeEqualStrings('short', 'much-longer-value')).not.toThrow()
    expect(timingSafeEqualStrings('short', 'much-longer-value')).toBe(false)
  })
})
