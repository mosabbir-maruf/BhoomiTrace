import { describe, expect, it } from 'vitest'

import {
  areasEqual,
  compareAreas,
  compareShares,
  formatArea,
  formatShare,
  NumericFormatError,
  parseArea,
  parseShare,
  sharesEqual,
  sumAreas,
} from '../../src/lib/rational.js'

describe('parseArea / formatArea', () => {
  it('parses integers and decimals at the supported scale', () => {
    expect(parseArea('33')).toBe(330_000n)
    expect(parseArea('18.5')).toBe(185_000n)
    expect(parseArea('0.48')).toBe(4_800n)
    expect(parseArea('125.0000')).toBe(1_250_000n)
    expect(parseArea('0')).toBe(0n)
  })

  it('accepts negative areas without losing exactness', () => {
    expect(parseArea('-1.25')).toBe(-12_500n)
  })

  it('tolerates insignificant trailing zeroes beyond the scale', () => {
    expect(parseArea('1.25000')).toBe(12_500n)
  })

  it('rejects values that would silently lose precision', () => {
    expect(() => parseArea('1.00001')).toThrow(NumericFormatError)
  })

  it('rejects malformed input', () => {
    for (const value of ['', 'abc', '1.2.3', '1,5', '1e3', '--1']) {
      expect(() => parseArea(value)).toThrow(NumericFormatError)
    }
  })

  it('round-trips through formatArea without trailing zeroes', () => {
    expect(formatArea(parseArea('33'))).toBe('33')
    expect(formatArea(parseArea('18.50'))).toBe('18.5')
    expect(formatArea(parseArea('0.4800'))).toBe('0.48')
    expect(formatArea(parseArea('0'))).toBe('0')
    expect(formatArea(parseArea('-1.25'))).toBe('-1.25')
  })
})

describe('area comparison and summation', () => {
  it('treats equal values written differently as equal', () => {
    expect(compareAreas('18.5', '18.5000')).toBe(0)
    expect(areasEqual('125', '125.0000')).toBe(true)
  })

  it('orders areas exactly', () => {
    expect(compareAreas('18.5', '18.5001')).toBe(-1)
    expect(compareAreas('19', '18.9999')).toBe(1)
  })

  it('avoids the floating-point error of naive addition', () => {
    // 0.1 + 0.2 !== 0.3 in binary floating point.
    expect(sumAreas(['0.1', '0.2'])).toBe('0.3')
    expect(compareAreas(sumAreas(['0.1', '0.2']), '0.3')).toBe(0)
  })

  it('sums the split case from the demo data exactly', () => {
    expect(sumAreas(['75.0000', '50.0000'])).toBe('125')
    expect(areasEqual(sumAreas(['75', '50']), '125.0000')).toBe(true)
  })

  it('sums an empty list to zero', () => {
    expect(sumAreas([])).toBe('0')
  })
})

describe('parseShare / formatShare', () => {
  it('reduces shares to lowest terms', () => {
    expect(parseShare('8/16')).toEqual({ numerator: 1n, denominator: 2n })
    expect(formatShare(parseShare('8/16'))).toBe('1/2')
  })

  it('treats a bare integer as a whole share', () => {
    expect(parseShare('2')).toEqual({ numerator: 2n, denominator: 1n })
    expect(formatShare(parseShare('1/1'))).toBe('1/1')
  })

  it('keeps the denominator positive', () => {
    expect(parseShare('-1/2')).toEqual({ numerator: -1n, denominator: 2n })
  })

  it('rejects a zero denominator', () => {
    expect(() => parseShare('1/0')).toThrow(NumericFormatError)
  })

  it('rejects malformed input', () => {
    for (const value of ['', 'abc', '1//2', '1/2/3', '1.5']) {
      expect(() => parseShare(value)).toThrow(NumericFormatError)
    }
  })
})

describe('share comparison', () => {
  it('compares exactly, so 1/3 and 2/6 are equal', () => {
    expect(compareShares('1/3', '2/6')).toBe(0)
    expect(sharesEqual('1/3', '2/6')).toBe(true)
  })

  it('orders shares that a decimal representation would confuse', () => {
    expect(compareShares('1/3', '1/2')).toBe(-1)
    expect(compareShares('2/3', '1/2')).toBe(1)
  })

  it('rejects decimal approximations of a share instead of comparing them', () => {
    // A share must stay an exact rational: "0.333333" is not one third.
    expect(() => parseShare('0.333333')).toThrow(NumericFormatError)
  })
})
