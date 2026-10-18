import { hash, verify } from '@node-rs/argon2'

import {
  ARGON2_ALGORITHM_ID,
  ARGON2_PARAMETERS,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
} from '../config/constants.js'

/**
 * Password hashing.
 *
 * Argon2id is used because it is memory-hard: it resists the GPU and ASIC
 * attacks that make a plain SHA-family digest unsuitable for passwords. The
 * cost parameters live in `../config/constants.js` and are asserted by a test,
 * so a dependency upgrade cannot quietly weaken them.
 *
 * A plaintext password is never stored, logged, or returned. Only the hash
 * leaves this module, and only towards the database.
 */

export const ARGON2_ALGORITHM = ARGON2_ALGORITHM_ID

/** Hashes a plaintext password with Argon2id. */
export async function hashPassword(plaintext: string): Promise<string> {
  return hash(plaintext, {
    algorithm: ARGON2_ALGORITHM,
    memoryCost: ARGON2_PARAMETERS.memoryCost,
    timeCost: ARGON2_PARAMETERS.timeCost,
    parallelism: ARGON2_PARAMETERS.parallelism,
    outputLen: ARGON2_PARAMETERS.outputLen,
  })
}

/**
 * Verifies a plaintext password against a stored hash.
 *
 * A malformed or truncated hash is treated as a failed verification rather than
 * an exception, so that corrupt data cannot turn a login attempt into a 500.
 */
export async function verifyPassword(
  storedHash: string,
  plaintext: string,
): Promise<boolean> {
  try {
    return await verify(storedHash, plaintext, {
      algorithm: ARGON2_ALGORITHM,
      memoryCost: ARGON2_PARAMETERS.memoryCost,
      timeCost: ARGON2_PARAMETERS.timeCost,
      parallelism: ARGON2_PARAMETERS.parallelism,
      outputLen: ARGON2_PARAMETERS.outputLen,
    })
  } catch {
    return false
  }
}

let dummyHash: Promise<string> | undefined

/**
 * A real hash of a throwaway value, computed once.
 *
 * Used when the submitted account does not exist, so that an unknown account
 * costs the same as a known one. Without this, response time would reveal which
 * email addresses are registered — an account-enumeration leak.
 */
function timingEqualisationHash(): Promise<string> {
  dummyHash ??= hashPassword('bhoomitrace-timing-equalisation-placeholder')
  return dummyHash
}

/**
 * Verifies against `storedHash`, or against a decoy when it is null.
 *
 * Always returns `false` when the account is unknown, and always performs one
 * Argon2id verification either way.
 */
export async function verifyPasswordOrDecoy(
  storedHash: string | null,
  plaintext: string,
): Promise<boolean> {
  if (storedHash === null) {
    await verifyPassword(await timingEqualisationHash(), plaintext)
    return false
  }
  return verifyPassword(storedHash, plaintext)
}

/** Result of checking a candidate password against the length policy. */
export interface PasswordPolicyResult {
  ok: boolean
  message?: string
}

/** PASSWORD_MIN_LENGTH / PASSWORD_MAX_LENGTH applied consistently. */
export function checkPasswordPolicy(plaintext: string): PasswordPolicyResult {
  if (plaintext.length < PASSWORD_MIN_LENGTH) {
    return {
      ok: false,
      message: `Password must be at least ${PASSWORD_MIN_LENGTH} characters long.`,
    }
  }
  if (plaintext.length > PASSWORD_MAX_LENGTH) {
    return {
      ok: false,
      message: `Password must be at most ${PASSWORD_MAX_LENGTH} characters long.`,
    }
  }
  return { ok: true }
}
