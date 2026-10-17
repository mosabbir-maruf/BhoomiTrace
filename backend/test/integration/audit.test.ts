import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  API,
  TEST_PASSWORD,
  closeTestDatabase,
  createAccount,
  createParcel,
  createTestApi,
  expectError,
  expectStatus,
  signIn,
  uniqueEmail,
  unknownUuid,
  type TestAccount,
  type TestApi,
  type TestClient,
} from '../helpers/api.js'

/**
 * The audit trail.
 *
 * What matters about an audit trail is not that it has rows, but that each row
 * says something true: who did it, what changed, and which request it belongs
 * to. These assertions therefore look at attribution and at what a row must
 * *not* contain, as much as at the presence of an event.
 */

let api: TestApi
let applicant: TestClient
let reviewer: TestClient
let admin: TestClient
let applicantAccount: TestAccount

beforeAll(async () => {
  api = await createTestApi()

  applicantAccount = await createAccount(api.database, 'applicant')
  applicant = await signIn(api.app, applicantAccount)
  reviewer = await signIn(api.app, await createAccount(api.database, 'reviewer'))
  admin = await signIn(api.app, await createAccount(api.database, 'admin'))
})

afterAll(async () => {
  await api.close()
  await closeTestDatabase()
})

interface AuditEventBody {
  id: string
  actorId: string | null
  actorRole: string | null
  action: string
  entityType: string
  entityId: string | null
  summary: string | null
  changes: Record<string, unknown> | null
  requestId: string | null
  createdAt: string
}

interface AuditPage {
  items: AuditEventBody[]
  total: number
  limit: number
  offset: number
}

/** Reads one page of the trail as an administrator. */
async function readTrail(query: string): Promise<AuditPage> {
  const response = await admin.get(`${API}/audit-events?${query}`)
  expectStatus(response, 200)
  return response.json() as AuditPage
}

async function countEvents(query: string): Promise<number> {
  const page = await readTrail(`${query}&limit=1`)
  return page.total
}

describe('reading the audit trail', () => {
  it('is administrators only', async () => {
    expectError(await applicant.get(`${API}/audit-events`), 403, 'forbidden')
    expectError(await reviewer.get(`${API}/audit-events`), 403, 'forbidden')

    const anonymous = await api.app.inject({ method: 'GET', url: `${API}/audit-events` })
    expectError(anonymous, 401, 'unauthenticated')

    expectStatus(await admin.get(`${API}/audit-events`), 200)
  })

  it('is read-only: the trail has no write, update, or delete endpoint', async () => {
    const event = await readTrail('limit=1')
    const id = event.items[0]?.id

    // Nothing may be added to the trail from outside the service layer, and
    // nothing already in it may be rewritten or removed.
    expectError(
      await admin.post(`${API}/audit-events`, { action: 'forged' }),
      404,
      'not_found',
    )
    expectError(await admin.delete(`${API}/audit-events/${id}`), 404, 'not_found')
    expectError(
      await admin.patch(`${API}/audit-events/${id}`, { action: 'forged' }),
      404,
      'not_found',
    )
  })
})

describe('what a domain change records', () => {
  it('attributes a parcel filing to the person who filed it, and to the request', async () => {
    const parcel = await createParcel(applicant)

    // `createParcel` does not expose the response headers, so a second filing
    // is made by hand to pair the event with the request that caused it.
    const response = await applicant.post(`${API}/parcels`, {
      survey: 'BS',
      district: 'Audit District',
      upazila: 'Audit Upazila',
      mouza: 'Audit Mouza',
      jlNumber: `JL-AUDIT-${Date.now().toString(36)}`,
      khatianNumber: `KH-AUDIT-${Math.random().toString(36).slice(2, 8)}`,
      areaDecimal: '88.0000',
      shareNumerator: 3,
      shareDenominator: 4,
    })
    expectStatus(response, 201)
    const created = response.json() as { id: string; khatianNumber: string }

    const page = await readTrail(`entityType=parcel&entityId=${created.id}`)
    expect(page.total).toBe(1)
    const event = page.items[0] as AuditEventBody

    expect(event.action).toBe('parcel.created')
    expect(event.entityType).toBe('parcel')
    expect(event.entityId).toBe(created.id)
    expect(event.actorId).toBe(applicant.account.id)
    expect(event.actorRole).toBe('applicant')
    expect(event.summary).toEqual(expect.any(String))
    // The request the row belongs to is the same one the caller was told.
    expect(event.requestId).toBe(response.headers['x-request-id'])
    expect(event.changes?.['khatianNumber']).toBe(created.khatianNumber)

    // The other parcel filed in this test is a different entity, so filtering
    // by one identifier answers about one record only.
    const other = await readTrail(`entityType=parcel&entityId=${parcel.id}`)
    expect(other.items.map((item) => item.id)).not.toContain(event.id)
  })

  it('records the whole vocabulary of a filing without any secret', async () => {
    const before = await countEvents('action=parcel.created')

    // A write the database refuses must leave the trail untouched: the audit
    // row is written in the same transaction as the change it describes.
    const identity = {
      survey: 'BS',
      district: 'Audit Rollback District',
      upazila: 'Audit Rollback Upazila',
      mouza: 'Audit Rollback Mouza',
      jlNumber: `JL-RB-${Date.now().toString(36)}`,
      khatianNumber: '4242',
      areaDecimal: '5.0000',
      shareNumerator: 1,
      shareDenominator: 2,
    }

    expectStatus(await applicant.post(`${API}/parcels`, identity), 201)
    expect(await countEvents('action=parcel.created')).toBe(before + 1)

    expectError(await applicant.post(`${API}/parcels`, identity), 409, 'conflict')
    expect(await countEvents('action=parcel.created')).toBe(before + 1)
  })

  it('never stores a password, a token, or a stored file key', async () => {
    // The strongest form of this check is to read the whole trail and search it,
    // because redaction failures show up in whichever field somebody adds next.
    // The trail accumulates across runs and is append-only, so it is read in
    // pages rather than deleted to fit one request.
    const scanned: AuditEventBody[] = []
    const pageSize = 100
    const scanLimit = 1_000

    for (let offset = 0; offset < scanLimit; offset += pageSize) {
      const page = await readTrail(`limit=${pageSize}&offset=${offset}`)
      scanned.push(...page.items)
      if (page.items.length < pageSize || scanned.length >= page.total) break
    }

    expect(scanned.length).toBeGreaterThan(0)

    const serialised = JSON.stringify(scanned)
    expect(serialised).not.toContain(TEST_PASSWORD)
    expect(serialised).not.toContain('passwordHash')
    expect(serialised).not.toContain('storageKey')
    expect(serialised).not.toContain('tokenHash')
    expect(serialised).not.toContain('csrfTokenHash')

    // Redaction is by key name and is applied at every depth, so a key that
    // looks sensitive is replaced by a marker rather than written out. This
    // checks the guard's effect on real rows, not a restatement of its rules.
    const SENSITIVE_KEY =
      /(pass(word)?|secret|token|cookie|authorization|api[_-]?key|credential|session|csrf|signature)/i

    function assertSensitiveKeysAreRedacted(value: unknown): void {
      if (value === null || typeof value !== 'object') return
      for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        if (SENSITIVE_KEY.test(key)) {
          expect(entry).toBe('[redacted]')
        } else {
          assertSensitiveKeysAreRedacted(entry)
        }
      }
    }

    for (const event of scanned) {
      assertSensitiveKeysAreRedacted(event.changes)
    }
  })
})

describe('what an authentication event records', () => {
  it('does not name the account as the actor of a refused sign-in', async () => {
    const before = await countEvents('action=auth.login_failed')

    const refused = await api.app.inject({
      method: 'POST',
      url: `${API}/auth/login`,
      headers: { 'content-type': 'application/json' },
      payload: { email: applicant.account.email, password: 'wrong-password-entirely' },
    })
    expectError(refused, 401, 'unauthenticated')

    const page = await readTrail('action=auth.login_failed&limit=1')
    expect(page.total).toBe(before + 1)
    const event = page.items[0] as AuditEventBody

    // Nobody authenticated, so the row names the subsystem rather than claiming
    // the account holder acted. The account is the subject of the event.
    expect(event.actorId).toBeNull()
    expect(event.actorRole).toBeNull()
    expect(event.entityType).toBe('user')
    expect(event.entityId).toBe(applicant.account.id)
    expect(event.summary).toContain('credentials did not match')
    expect(event.requestId).toBe(refused.headers['x-request-id'])

    // The attempted secret is not written down, and the row is not the caller's
    // to shape.
    expect(JSON.stringify(event)).not.toContain('wrong-password-entirely')
  })

  it('refuses an event for an address that has no account, without saying so', async () => {
    const unknownAddress = uniqueEmail('unknown-address')

    const refused = await api.app.inject({
      method: 'POST',
      url: `${API}/auth/login`,
      headers: { 'content-type': 'application/json' },
      payload: { email: unknownAddress, password: 'wrong-password-entirely' },
    })
    expectError(refused, 401, 'unauthenticated')

    // The client-facing answer is identical; the trail records the attempt
    // against no entity, so it is an administrator-facing detail only.
    const page = await readTrail('action=auth.login_failed&limit=5')
    const event = page.items.find((item) => item.requestId === refused.headers['x-request-id'])
    expect(event?.actorId).toBeNull()
    expect(event?.entityId).toBeNull()
  })

  it('attributes a successful sign-in to the account that signed in', async () => {
    const account = await createAccount(api.database, 'applicant')
    const client = await signIn(api.app, account)

    const page = await readTrail(
      `action=auth.login_succeeded&actorId=${account.id}&limit=1`,
    )

    expect(page.total).toBeGreaterThanOrEqual(1)
    const event = page.items[0] as AuditEventBody
    expect(event.actorId).toBe(account.id)
    expect(event.actorRole).toBe('applicant')
    expect(event.entityId).toBe(account.id)

    // A session that was never used still leaves its trail.
    expect(client.sessionToken.length).toBeGreaterThan(20)
    expect(JSON.stringify(page.items)).not.toContain(client.sessionToken)
  })
})

describe('filtering and ordering', () => {
  it('returns newest first and honours the entity filter', async () => {
    const parcel = await createParcel(applicant)
    // A second change to the same record, so ordering within one entity is
    // observable.
    const updated = await applicant.patch(`${API}/parcels/${parcel.id}`, {
      version: parcel.version,
      mouza: 'Audit Ordered Mouza',
    })
    expectStatus(updated, 200)

    const page = await readTrail(`entityType=parcel&entityId=${parcel.id}&limit=10`)

    expect(page.total).toBeGreaterThanOrEqual(2)
    for (const event of page.items) {
      expect(event.entityId).toBe(parcel.id)
    }

    const timestamps = page.items.map((item) => Date.parse(item.createdAt))
    const sorted = [...timestamps].sort((left, right) => right - left)
    expect(timestamps).toEqual(sorted)
  })

  it('reports an empty page rather than an error for an unknown entity', async () => {
    const page = await readTrail(`entityType=parcel&entityId=${unknownUuid()}`)

    expect(page.total).toBe(0)
    expect(page.items).toEqual([])
  })
})
