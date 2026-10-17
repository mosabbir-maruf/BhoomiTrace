import { describe, expect, it } from 'vitest'

import { redactForAudit, safeErrorSummary } from '../../src/lib/redact.js'

/**
 * Redaction.
 *
 * Audit rows are long-lived, read by people, and routinely copied into logs and
 * reports, which makes them the most likely place for a secret to escape. These
 * tests exist because a missed key name is invisible until it matters.
 */

describe('redactForAudit', () => {
  it('replaces every value stored under a sensitive-looking key', () => {
    const redacted = redactForAudit({
      password: 'hunter2',
      passwordHash: '$argon2id$...',
      secret: 'shh',
      token: 'opaque',
      sessionToken: 'opaque',
      sessionId: 'identifier',
      csrfToken: 'opaque',
      cookie: 'bt_session=...',
      cookieHeader: 'bt_session=...',
      authorization: 'Bearer abc',
      apiKey: 'key',
      api_key: 'key',
      credential: 'value',
      signature: 'value',
    }) as Record<string, unknown>

    for (const value of Object.values(redacted)) {
      expect(value).toBe('[redacted]')
    }
  })

  it('keeps ordinary fields intact', () => {
    const redacted = redactForAudit({
      parcelId: 'a1000000-0000-4000-8000-000000000001',
      field: 'area',
      recordedValue: '125.0000',
      isUnclear: false,
      count: 3,
      nothing: null,
    })

    expect(redacted).toEqual({
      parcelId: 'a1000000-0000-4000-8000-000000000001',
      field: 'area',
      recordedValue: '125.0000',
      isUnclear: false,
      count: 3,
      nothing: null,
    })
  })

  it('redacts at every depth, including inside arrays', () => {
    const redacted = redactForAudit({
      before: { status: 'queued', sessionToken: 'opaque' },
      after: { status: 'completed' },
      attempts: [
        { attempt: 1, apiKey: 'key', reason: 'timeout' },
        { attempt: 2, reason: 'timeout' },
      ],
    }) as {
      before: Record<string, unknown>
      attempts: Record<string, unknown>[]
    }

    expect(redacted.before['sessionToken']).toBe('[redacted]')
    expect(redacted.before['status']).toBe('queued')
    expect(redacted.attempts[0]?.['apiKey']).toBe('[redacted]')
    expect(redacted.attempts[0]?.['reason']).toBe('timeout')
    expect(redacted.attempts[1]?.['reason']).toBe('timeout')
  })

  it('truncates a long string rather than storing it whole', () => {
    const redacted = redactForAudit('x'.repeat(5_000))

    expect(typeof redacted).toBe('string')
    expect((redacted as string).length).toBeLessThan(600)
    expect(redacted as string).toMatch(/…$/)
  })

  it('caps an array so a bulk change cannot bloat a row', () => {
    const redacted = redactForAudit(
      Array.from({ length: 200 }, (_value, index) => index),
    ) as number[]

    expect(redacted).toHaveLength(50)
  })

  it('stops recursing rather than following a deliberately deep structure', () => {
    let nested: Record<string, unknown> = { value: 'bottom' }
    for (let depth = 0; depth < 20; depth += 1) nested = { nested }

    const redacted = JSON.stringify(redactForAudit(nested))
    expect(redacted).toContain('[truncated]')
    expect(redacted).not.toContain('bottom')
  })

  it('makes a non-JSON value safe to store instead of dropping the row', () => {
    const redacted = redactForAudit({
      when: new Date('2026-01-02T03:04:05.000Z'),
      big: BigInt(9_007_199_254_740_993n),
      failure: new Error('provider exploded'),
    }) as Record<string, unknown>

    expect(redacted['when']).toBe('2026-01-02T03:04:05.000Z')
    expect(redacted['big']).toBe('9007199254740993')
    // An `Error`'s message and stack are non-enumerable, so nothing is copied.
    // That is the safe direction: an unexpected error object cannot smuggle its
    // contents into a long-lived row.
    expect(redacted['failure']).toEqual({})
  })
})

describe('safeErrorSummary', () => {
  it('strips a connection string out of an error message', () => {
    const summary = safeErrorSummary(
      new Error('connect failed for postgres://user:pw@127.0.0.1:5433/secret'),
    )

    expect(summary).toContain('[redacted-connection-string]')
    expect(summary).not.toContain('user:pw')
    expect(summary).not.toContain('5433')
  })

  it('strips a query-string style secret', () => {
    const summary = safeErrorSummary(new Error('GET /x?api_key=abc123&y=1 failed'))

    expect(summary).not.toContain('abc123')
    expect(summary).toContain('y=1')
  })

  it('truncates an enormous message', () => {
    const summary = safeErrorSummary(new Error('x'.repeat(5_000)))

    expect(summary.length).toBeLessThanOrEqual(320)
  })

  it('names the error class so a failure can be triaged', () => {
    expect(safeErrorSummary(new TypeError('bad shape'))).toBe('TypeError: bad shape')
  })

  it('handles a thrown non-error', () => {
    expect(safeErrorSummary('just a string')).toBe('UnknownError')
    expect(safeErrorSummary(undefined)).toBe('UnknownError')
    expect(safeErrorSummary({ weird: true })).toBe('UnknownError')
  })
})
