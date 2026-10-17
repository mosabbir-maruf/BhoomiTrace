import { z } from 'zod'

/**
 * Bounded pagination.
 *
 * Every list endpoint accepts the same parameters and enforces the same ceiling.
 * The limit is bounded rather than caller-chosen so that a single request
 * cannot ask the database for an unbounded result set.
 */

export const DEFAULT_PAGE_SIZE = 20
export const MAX_PAGE_SIZE = 100

export const paginationQuerySchema = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_PAGE_SIZE)
    .default(DEFAULT_PAGE_SIZE),
  offset: z.coerce.number().int().min(0).default(0),
})

export type PaginationQuery = z.infer<typeof paginationQuerySchema>

/** The pagination fields as they arrive from a route's validated query string. */
export interface PaginationInput {
  readonly limit?: number | undefined
  readonly offset?: number | undefined
}

/**
 * Narrows a validated query object to its pagination fields.
 *
 * Every list route extends the shared pagination schema, so the values are
 * already coerced integers with the defaults applied. This exists so services
 * receive exactly two fields rather than the whole query, and so the bounds are
 * re-applied here: a service is then safe to call with a query object that was
 * assembled by hand in a test.
 */
export function parsePagination(query: PaginationInput): PaginationQuery {
  return {
    limit: Math.min(query.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE),
    offset: Math.max(query.offset ?? 0, 0),
  }
}

export interface Page<T> {
  items: T[]
  total: number
  limit: number
  offset: number
  hasMore: boolean
}

/** Assembles a page envelope from a row set and its total count. */
export function pageOf<T>(
  items: readonly T[],
  total: number,
  query: PaginationQuery,
): Page<T> {
  return {
    items: [...items],
    total,
    limit: query.limit,
    offset: query.offset,
    hasMore: query.offset + items.length < total,
  }
}
