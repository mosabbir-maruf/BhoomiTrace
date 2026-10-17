import { describe, expect, it } from 'vitest'

import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  pageOf,
  parsePagination,
} from '../../src/lib/pagination.js'

/**
 * Bounded pagination.
 *
 * A caller must not be able to ask the database for an unbounded result set, so
 * the ceiling is enforced in one place and reused by every list route.
 */

describe('parsePagination', () => {
  it('applies the defaults when nothing is supplied', () => {
    expect(parsePagination({})).toEqual({
      limit: DEFAULT_PAGE_SIZE,
      offset: 0,
    })
  })

  it('keeps values that are already within bounds', () => {
    expect(parsePagination({ limit: 25, offset: 50 })).toEqual({
      limit: 25,
      offset: 50,
    })
  })

  it('refuses to pass a ceiling breach through to the query', () => {
    expect(parsePagination({ limit: 10_000 }).limit).toBe(MAX_PAGE_SIZE)
    expect(parsePagination({ limit: MAX_PAGE_SIZE }).limit).toBe(MAX_PAGE_SIZE)
  })

  it('never produces a negative offset', () => {
    expect(parsePagination({ offset: -100 }).offset).toBe(0)
  })
})

describe('pageOf', () => {
  it('reports whether more rows exist after this page', () => {
    expect(pageOf(['a', 'b'], 5, { limit: 2, offset: 0 })).toEqual({
      items: ['a', 'b'],
      total: 5,
      limit: 2,
      offset: 0,
      hasMore: true,
    })

    expect(pageOf(['e'], 5, { limit: 2, offset: 4 }).hasMore).toBe(false)
  })

  it('copies the items so a caller cannot mutate the source array', () => {
    const source = ['a']
    const page = pageOf(source, 1, { limit: 20, offset: 0 })
    page.items.push('b')

    expect(source).toEqual(['a'])
  })

  it('reports an empty page cleanly', () => {
    expect(pageOf([], 0, { limit: 20, offset: 0 })).toEqual({
      items: [],
      total: 0,
      limit: 20,
      offset: 0,
      hasMore: false,
    })
  })
})
