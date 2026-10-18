/**
 * Exact arithmetic for land areas and ownership shares.
 *
 * Land areas and shares are authoritative values in BhoomiTrace, so they are
 * never handled as IEEE-754 floats. Areas are held as integers scaled by
 * `10^AREA_SCALE` (matching the `numeric(14,4)` column precision), and shares
 * are held as exact rationals. Both use `BigInt`, so comparisons and sums are
 * exact and lossless.
 */

/** Decimal places used by the `numeric(14, 4)` area columns. */
export const AREA_SCALE = 4

const AREA_FACTOR = 10n ** BigInt(AREA_SCALE)

const AREA_PATTERN = /^([+-]?)(\d+)(?:\.(\d+))?$/
const SHARE_PATTERN = /^([+-]?)(\d+)(?:\/(\d+))?$/

/** Thrown when a string cannot be read as an exact area or share. */
export class NumericFormatError extends Error {
  override readonly name = 'NumericFormatError'

  constructor(
    readonly kind: 'area' | 'share',
    readonly input: string,
    reason: string,
  ) {
    super(`Invalid ${kind} "${input}": ${reason}`)
  }
}

function greatestCommonDivisor(a: bigint, b: bigint): bigint {
  let left = a < 0n ? -a : a
  let right = b < 0n ? -b : b
  while (right !== 0n) {
    const remainder = left % right
    left = right
    right = remainder
  }
  return left
}

/* -------------------------------------------------------------------------- */
/* Areas                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Parses a decimal area into its scaled integer representation.
 *
 * @throws {NumericFormatError} on malformed input, or when more than
 *   `AREA_SCALE` decimal places are supplied with a non-zero remainder (which
 *   would silently lose precision).
 */
export function parseArea(value: string): bigint {
  const match = AREA_PATTERN.exec(value.trim())
  if (!match) {
    throw new NumericFormatError('area', value, 'expected a decimal number')
  }

  const [, sign, whole = '0', fraction = ''] = match

  if (fraction.length > AREA_SCALE) {
    const discarded = fraction.slice(AREA_SCALE)
    if (/[1-9]/.test(discarded)) {
      throw new NumericFormatError(
        'area',
        value,
        `at most ${AREA_SCALE} decimal places are supported`,
      )
    }
  }

  const padded = fraction.slice(0, AREA_SCALE).padEnd(AREA_SCALE, '0')
  const magnitude = BigInt(whole) * AREA_FACTOR + BigInt(padded)

  return sign === '-' ? -magnitude : magnitude
}

/** Renders a scaled area without trailing zeroes. */
export function formatArea(scaled: bigint): string {
  const negative = scaled < 0n
  const magnitude = negative ? -scaled : scaled
  const whole = magnitude / AREA_FACTOR
  const fraction = (magnitude % AREA_FACTOR)
    .toString()
    .padStart(AREA_SCALE, '0')
    .replace(/0+$/, '')

  const body = fraction.length > 0 ? `${whole}.${fraction}` : whole.toString()
  return negative ? `-${body}` : body
}

/** Exact three-way comparison of two decimal areas. */
export function compareAreas(left: string, right: string): -1 | 0 | 1 {
  const a = parseArea(left)
  const b = parseArea(right)
  if (a < b) return -1
  if (a > b) return 1
  return 0
}

/** Returns true when two decimal areas are exactly equal. */
export function areasEqual(left: string, right: string): boolean {
  return parseArea(left) === parseArea(right)
}

/** Sums decimal areas exactly and renders the result as a decimal string. */
export function sumAreas(values: readonly string[]): string {
  let total = 0n
  for (const value of values) total += parseArea(value)
  return formatArea(total)
}

/* -------------------------------------------------------------------------- */
/* Shares                                                                      */
/* -------------------------------------------------------------------------- */

/** An ownership share held as an exact fraction in lowest terms. */
export interface RationalShare {
  readonly numerator: bigint
  /** Always strictly positive. */
  readonly denominator: bigint
}

/**
 * Parses an ownership share such as `"1/3"`, `"8/16"` or `"2"`.
 *
 * The result is reduced to lowest terms with a positive denominator.
 *
 * @throws {NumericFormatError} on malformed input or a zero denominator.
 */
export function parseShare(value: string): RationalShare {
  const match = SHARE_PATTERN.exec(value.trim())
  if (!match) {
    throw new NumericFormatError('share', value, 'expected "n/d" or "n"')
  }

  const [, sign, numeratorPart = '0', denominatorPart = '1'] = match
  const denominator = BigInt(denominatorPart)

  if (denominator === 0n) {
    throw new NumericFormatError('share', value, 'denominator must not be zero')
  }

  const numerator = sign === '-' ? -BigInt(numeratorPart) : BigInt(numeratorPart)
  const divisor = greatestCommonDivisor(numerator, denominator)

  return {
    numerator: numerator / divisor,
    denominator: denominator / divisor,
  }
}

/** Renders a share as `"numerator/denominator"`. */
export function formatShare(share: RationalShare): string {
  return `${share.numerator}/${share.denominator}`
}

/** Exact three-way comparison of two shares. */
export function compareShares(left: string, right: string): -1 | 0 | 1 {
  const a = parseShare(left)
  const b = parseShare(right)
  const difference = a.numerator * b.denominator - b.numerator * a.denominator
  if (difference < 0n) return -1
  if (difference > 0n) return 1
  return 0
}

/** Returns true when two shares are exactly equal. */
export function sharesEqual(left: string, right: string): boolean {
  return compareShares(left, right) === 0
}
