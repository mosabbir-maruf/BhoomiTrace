import { describe, expect, it } from 'vitest'

import {
  ARGON2_ALGORITHM_ID,
  ARGON2_PARAMETERS,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
} from '../../src/config/constants.js'
import {
  ARGON2_ALGORITHM,
  checkPasswordPolicy,
  hashPassword,
  verifyPassword,
  verifyPasswordOrDecoy,
} from '../../src/lib/password.js'

/**
 * Password hashing.
 *
 * The point of these tests is that the *strength* of the scheme is pinned, not
 * just its behaviour. A dependency upgrade that silently lowered the Argon2id
 * cost, or switched the algorithm, would change the encoded parameters in every
 * new hash — and would fail here.
 */

const PASSPHRASE = 'correct-horse-battery-staple'

describe('Argon2id parameters', () => {
  it('is pinned to the OWASP-recommended Argon2id baseline', () => {
    expect(ARGON2_PARAMETERS).toEqual({
      memoryCost: 19_456,
      timeCost: 2,
      parallelism: 1,
      outputLen: 32,
    })
  })

  it('selects the Argon2id algorithm', () => {
    // `Algorithm.Argon2id` from `@node-rs/argon2` is 2. The constant is written
    // out literally there because the package declares it as an ambient const
    // enum; this assertion is what keeps the literal honest.
    expect(ARGON2_ALGORITHM_ID).toBe(2)
    expect(ARGON2_ALGORITHM).toBe(2)
  })
})

describe('hashPassword', () => {
  it('produces an Argon2id hash encoding the configured cost', async () => {
    const digest = await hashPassword(PASSPHRASE)

    expect(digest).toMatch(/^\$argon2id\$/)
    expect(digest).toContain('$m=19456,t=2,p=1$')
    // A salt and a digest are present, neither of them the plaintext.
    expect(digest).not.toContain(PASSPHRASE)
    expect(digest.split('$')).toHaveLength(6)
  })

  it('salts each hash, so the same password never hashes the same twice', async () => {
    const first = await hashPassword(PASSPHRASE)
    const second = await hashPassword(PASSPHRASE)

    expect(first).not.toBe(second)
  })
})

describe('verifyPassword', () => {
  it('accepts the correct password and rejects anything else', async () => {
    const digest = await hashPassword(PASSPHRASE)

    await expect(verifyPassword(digest, PASSPHRASE)).resolves.toBe(true)
    await expect(verifyPassword(digest, `${PASSPHRASE}!`)).resolves.toBe(false)
    await expect(verifyPassword(digest, '')).resolves.toBe(false)
  })

  it('treats a malformed or truncated hash as a failed verification', async () => {
    // Corrupt data must not turn a login attempt into an unhandled 500.
    await expect(verifyPassword('not-a-hash', PASSPHRASE)).resolves.toBe(false)
    await expect(verifyPassword('$argon2id$v=19$m=19456,t=2,p=1$abc', PASSPHRASE)).resolves.toBe(
      false,
    )
    await expect(verifyPassword('', PASSPHRASE)).resolves.toBe(false)
  })
})

describe('verifyPasswordOrDecoy', () => {
  it('rejects an unknown account without throwing', async () => {
    await expect(verifyPasswordOrDecoy(null, PASSPHRASE)).resolves.toBe(false)
  })

  it('still performs a real Argon2id verification for an unknown account', async () => {
    // Account enumeration is defeated by making the unknown-account path cost
    // the same as the known-account path. That only holds if the decoy hash is
    // genuinely verified. A 19 MiB Argon2id verification cannot complete
    // instantly, so a generous lower bound is enough to prove work happened: if
    // the decoy were malformed, verification would fail in well under a
    // millisecond and this assertion would fail.
    const startedAt = Date.now()
    await verifyPasswordOrDecoy(null, PASSPHRASE)
    const elapsedMs = Date.now() - startedAt

    expect(elapsedMs).toBeGreaterThan(3)
  })

  it('falls through to the stored hash when the account exists', async () => {
    const digest = await hashPassword(PASSPHRASE)

    await expect(verifyPasswordOrDecoy(digest, PASSPHRASE)).resolves.toBe(true)
    await expect(verifyPasswordOrDecoy(digest, 'wrong-password-entirely')).resolves.toBe(false)
  })
})

describe('checkPasswordPolicy', () => {
  it('accepts a password at the minimum length and rejects one below it', () => {
    expect(checkPasswordPolicy('a'.repeat(PASSWORD_MIN_LENGTH)).ok).toBe(true)
    expect(checkPasswordPolicy('a'.repeat(PASSWORD_MIN_LENGTH - 1)).ok).toBe(false)
  })

  it('accepts a password at the maximum length and rejects one above it', () => {
    expect(checkPasswordPolicy('a'.repeat(PASSWORD_MAX_LENGTH)).ok).toBe(true)

    const tooLong = checkPasswordPolicy('a'.repeat(PASSWORD_MAX_LENGTH + 1))
    expect(tooLong.ok).toBe(false)
  })

  it('states the rule it applied without echoing the password', () => {
    const result = checkPasswordPolicy('short')

    expect(result.ok).toBe(false)
    expect(result.message).toContain(String(PASSWORD_MIN_LENGTH))
    expect(result.message).not.toContain('short')
  })
})
