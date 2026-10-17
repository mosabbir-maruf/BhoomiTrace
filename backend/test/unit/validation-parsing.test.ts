import { describe, expect, it } from 'vitest'

import { normaliseDigits, tryParseArea, tryParseShare } from '../../src/validation/rules.js'

/**
 * Reading values out of a synthetic land record.
 *
 * These three functions decide the difference between "the record disagrees with
 * the document" and "nobody has read this yet". Getting that wrong is not a
 * cosmetic bug: it would tell a reviewer that a smudged entry is a mismatch,
 * which is an assertion the data does not support.
 *
 * Nothing here guesses. A value that is not entirely a number — or not entirely
 * a share — is unreadable, and unreadable means `null`.
 */

describe('normaliseDigits', () => {
  it('maps Bangla digits to their ASCII values', () => {
    expect(normaliseDigits('০১২৩৪৫৬৭৮৯')).toBe('0123456789')
  })

  it('leaves other characters alone, including other scripts', () => {
    expect(normaliseDigits('খতিয়ান ১২৩ / দাগ-৪')).toBe('খতিয়ান 123 / দাগ-4')
  })

  it('is idempotent', () => {
    expect(normaliseDigits(normaliseDigits('৪২'))).toBe('42')
  })
})

describe('tryParseArea', () => {
  it('reads an ASCII decimal in any script', () => {
    expect(tryParseArea('125.0000')).toBe(tryParseArea('১২৫.০০০০'))
    expect(tryParseArea('125')).not.toBeNull()
  })

  it('treats a missing or unreadable value as unknown, never as zero', () => {
    expect(tryParseArea(null)).toBeNull()
    expect(tryParseArea(undefined)).toBeNull()
    expect(tryParseArea('')).toBeNull()
    expect(tryParseArea('   ')).toBeNull()
    // A smudged entry with words around it is not a number.
    expect(tryParseArea('১২৫ দশমিক শূন্য')).toBeNull()
    expect(tryParseArea('১২৫ (অস্পষ্ট)')).toBeNull()
    expect(tryParseArea('প্রায় ১২৫')).toBeNull()
    expect(tryParseArea('N/A')).toBeNull()
  })

  it('distinguishes an exact zero from an unreadable value', () => {
    // Zero is a measurement; unknown is not.
    expect(tryParseArea('0')).not.toBeNull()
    expect(tryParseArea('0.0000')).not.toBeNull()
    expect(tryParseArea('unclear')).toBeNull()
  })

  it('has no floating-point tolerance: a different value is a different value', () => {
    expect(tryParseArea('125.0001')).not.toBe(tryParseArea('125.0000'))
    expect(tryParseArea('125.00000')).toBe(tryParseArea('125.0000'))
  })
})

describe('tryParseShare', () => {
  it('reads a share in either script and normalises it', () => {
    expect(tryParseShare('1/2')).toBe('1/2')
    expect(tryParseShare('১/২')).toBe('1/2')
    expect(tryParseShare('4/8')).toBe('1/2')
  })

  it('requires the whole value to be a share', () => {
    // A share followed by a note is an entry somebody has to read, not a value
    // to be salvaged.
    expect(tryParseShare('১/২ (অস্পষ্ট)')).toBeNull()
    expect(tryParseShare('1/2 unclear')).toBeNull()
    expect(tryParseShare('about 1/2')).toBeNull()
    expect(tryParseShare('1 / 2')).toBeNull()
  })

  it('refuses a share the arithmetic cannot represent', () => {
    expect(tryParseShare('1/0')).toBeNull()
    expect(tryParseShare('/2')).toBeNull()
    expect(tryParseShare('1/')).toBeNull()
    expect(tryParseShare(null)).toBeNull()
    expect(tryParseShare('')).toBeNull()
  })

  it('keeps the value exact rather than approximating it', () => {
    // A third cannot be written as a decimal, so it stays a ratio.
    expect(tryParseShare('1/3')).toBe('1/3')
    expect(tryParseShare('2/6')).toBe('1/3')
  })
})
