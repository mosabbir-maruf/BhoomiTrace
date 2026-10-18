import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  API,
  createAccount,
  createParcel,
  createTestApi,
  expectError,
  expectStatus,
  signIn,
  unknownUuid,
  type ParcelBody,
  type TestApi,
  type TestClient,
} from '../helpers/api.js'

/**
 * Parcel records: ownership, concurrency, and lifecycle.
 *
 * Three properties are worth more than the rest, and each has a test:
 *
 * 1. An applicant can never see or change a filing that is not theirs, and the
 *    answer is `404` rather than `403`, so an identifier cannot be used to
 *    discover that a record exists.
 * 2. A concurrent edit is refused rather than silently overwritten.
 * 3. Nothing is ever deleted. Retiring a record keeps the evidence.
 */

let api: TestApi
let applicant: TestClient
let otherApplicant: TestClient
let reviewer: TestClient
let admin: TestClient

beforeAll(async () => {
  api = await createTestApi()

  const applicantAccount = await createAccount(api.database, 'applicant')
  const otherAccount = await createAccount(api.database, 'applicant')
  const reviewerAccount = await createAccount(api.database, 'reviewer')
  const adminAccount = await createAccount(api.database, 'admin')

  applicant = await signIn(api.app, applicantAccount)
  otherApplicant = await signIn(api.app, otherAccount)
  reviewer = await signIn(api.app, reviewerAccount)
  admin = await signIn(api.app, adminAccount)
})

afterAll(async () => {
  await api.close()
})

describe('POST /parcels', () => {
  it('creates a record owned by the caller, marked as user-created', async () => {
    const parcel = await createParcel(applicant, {
      ...identity('CREATE-OWN'),
      areaDecimal: '120.5000',
      shareNumerator: 3,
      shareDenominator: 8,
      dagNumbers: ['200', '100'],
    })

    expect(parcel.ownerId).toBe(applicant.account.id)
    // The seeded demo dataset is written by the seed, never through the API, so
    // an API-created row is always the user's own.
    expect(parcel.origin).toBe('user_created')
    expect(parcel.lifecycle).toBe('active')
    expect(parcel.version).toBe(1)
    expect(parcel.retirementReason).toBeNull()
    expect(parcel.retiredAt).toBeNull()

    // The area is returned as an exact decimal string, never as a double.
    expect(parcel.areaDecimal).toBe('120.5000')
    expect(typeof parcel.areaDecimal).toBe('string')

    // The share is exact and reduced, and both representations agree.
    expect(parcel.shareNumerator).toBe(3)
    expect(parcel.shareDenominator).toBe(8)
    expect(parcel.ownershipShare).toBe('3/8')

    expect(parcel.dagNumbers).toEqual(['100', '200'])
    expect(parcel.createdAt).toEqual(expect.any(String))
  })

  it('reduces a share that was not in lowest terms', async () => {
    const parcel = await createParcel(applicant, {
      ...identity('REDUCE'),
      shareNumerator: 4,
      shareDenominator: 8,
    })

    expect(parcel.shareNumerator).toBe(4)
    expect(parcel.shareDenominator).toBe(8)
    // `ownershipShare` is the canonical rendering of the same rational.
    expect(parcel.ownershipShare).toBe('1/2')
  })

  it('requires authentication', async () => {
    const response = await api.app.inject({
      method: 'POST',
      url: `${API}/parcels`,
      headers: { 'content-type': 'application/json' },
      payload: minimalParcel(),
    })

    expectError(response, 401, 'unauthenticated')
  })

  it('requires a CSRF token', async () => {
    const response = await applicant.post(`${API}/parcels`, minimalParcel(), {
      withCsrf: false,
    })

    expectError(response, 403, 'forbidden')
  })

  it('rejects a negative area and a zero denominator', async () => {
    const negativeArea = await applicant.post(`${API}/parcels`, {
      ...minimalParcel(),
      areaDecimal: '-5.0000',
    })
    expectError(negativeArea, 422, 'validation_failed')

    const zeroDenominator = await applicant.post(`${API}/parcels`, {
      ...minimalParcel(),
      shareDenominator: 0,
    })
    expectError(zeroDenominator, 422, 'validation_failed')
  })

  it('rejects a share denominator of zero before it reaches the database', async () => {
    // The database has the same check; the API refuses it first, which is the
    // cheap place to catch it.
    const response = await applicant.post(`${API}/parcels`, {
      ...minimalParcel(),
      shareNumerator: 1,
      shareDenominator: 0,
    })

    expectError(response, 422, 'validation_failed')
    expect(response.body).not.toContain('parcels_share_denominator_positive')
  })

  it('ignores an ownerId sent by an applicant', async () => {
    const parcel = await createParcel(applicant, {
      ...identity('IGNORED-OWNER'),
      ownerId: otherApplicant.account.id,
    })

    // Filing a record in somebody else's name is not possible; the field is
    // read only for an administrator.
    expect(parcel.ownerId).toBe(applicant.account.id)
  })

  it('does not let a reviewer create a filing', async () => {
    const response = await reviewer.post(`${API}/parcels`, minimalParcel())

    expectError(response, 403, 'forbidden')
  })

  it('lets an administrator file on behalf of an account', async () => {
    const parcel = await createParcel(admin, {
      ...identity('ADMIN-FOR-APPLICANT'),
      ownerId: applicant.account.id,
    })

    expect(parcel.ownerId).toBe(applicant.account.id)
    expect(parcel.origin).toBe('user_created')
  })

  it('refuses an administrator filing for an account that does not exist', async () => {
    const response = await admin.post(`${API}/parcels`, {
      ...minimalParcel(),
      ownerId: unknownUuid(),
    })

    expectError(response, 404, 'not_found')
  })

  it('refuses a second record with the same survey identity', async () => {
    const draft = identity('DUPLICATE')
    await createParcel(applicant, draft)

    // Uniqueness is (survey, district, upazila, mouza, jlNumber, khatian).
    const response = await applicant.post(`${API}/parcels`, {
      ...minimalParcel(),
      ...draft,
    })

    const body = expectError(response, 409, 'conflict')
    // Constraint internals never reach the caller.
    expect(body.error.message).not.toContain('parcels_identity_unique')
    expect(body.error.message).not.toContain('duplicate key')
  })
})

describe('GET /parcels', () => {
  it('shows an applicant only their own records', async () => {
    const mine = await createParcel(applicant, identity('LIST-MINE'))
    const theirs = await createParcel(otherApplicant, identity('LIST-THEIRS'))

    const response = await applicant.get(`${API}/parcels?limit=100`)

    expectStatus(response, 200)
    const body = response.json() as { items: ParcelBody[]; total: number }

    const ids = body.items.map((item) => item.id)
    expect(ids).toContain(mine.id)
    expect(ids).not.toContain(theirs.id)
    expect(body.items.every((item) => item.ownerId === applicant.account.id)).toBe(true)
  })

  it('shows a reviewer the demo records as well as filed ones', async () => {
    const response = await reviewer.get(`${API}/parcels?limit=100&origin=synthetic_demo`)

    expectStatus(response, 200)
    const body = response.json() as { items: ParcelBody[] }

    expect(body.items.length).toBeGreaterThan(0)
    for (const item of body.items) {
      expect(item.origin).toBe('synthetic_demo')
      // Demo records are not owned by a person.
      expect(item.ownerId).toBeNull()
    }
  })

  it('never shows a demo record to an applicant', async () => {
    const response = await applicant.get(`${API}/parcels?limit=100&origin=synthetic_demo`)

    expectStatus(response, 200)
    expect((response.json() as { items: unknown[] }).items).toEqual([])
  })

  it('bounds the page size and reports what remains', async () => {
    for (let index = 0; index < 3; index += 1) {
      await createParcel(applicant, identity('PAGING'))
    }

    const filter = districtFilter('PAGING')

    const first = await applicant.get(`${API}/parcels?limit=2&offset=0&${filter}`)
    expectStatus(first, 200)

    const page = first.json() as {
      items: ParcelBody[]
      total: number
      limit: number
      offset: number
      hasMore: boolean
    }
    expect(page.limit).toBe(2)
    expect(page.offset).toBe(0)
    expect(page.total).toBe(3)
    expect(page.items).toHaveLength(2)
    expect(page.hasMore).toBe(true)

    const second = await applicant.get(`${API}/parcels?limit=2&offset=2&${filter}`)
    expectStatus(second, 200)

    const lastPage = second.json() as { items: ParcelBody[]; hasMore: boolean }
    expect(lastPage.items).toHaveLength(1)
    expect(lastPage.hasMore).toBe(false)
  })

  it('refuses a page size above the ceiling', async () => {
    const response = await applicant.get(`${API}/parcels?limit=100000`)
    expectError(response, 422, 'validation_failed')
  })

  it('filters by a partial location and an exact khatian number', async () => {
    const target = await createParcel(applicant, {
      ...identity('FILTER'),
      district: `Filterable District ${RUN}`,
      mouza: `Filterable Mouza ${RUN}`,
    })

    // A partial, case-insensitive match: the stored value is
    // "Filterable District <run>", the filter is a fragment of it.
    const byDistrict = await applicant.get(
      `${API}/parcels?limit=100&district=${encodeURIComponent(`district ${RUN}`)}`,
    )
    expectStatus(byDistrict, 200)
    expect((byDistrict.json() as { items: ParcelBody[] }).items.map((i) => i.id)).toContain(
      target.id,
    )

    const byKhatian = await applicant.get(
      `${API}/parcels?limit=100&khatianNumber=${encodeURIComponent(target.khatianNumber)}`,
    )
    expectStatus(byKhatian, 200)
    expect((byKhatian.json() as { items: ParcelBody[] }).items.map((i) => i.id)).toEqual([
      target.id,
    ])
  })
})

describe('GET /parcels/:parcelId', () => {
  it('returns a record to its owner', async () => {
    const parcel = await createParcel(applicant, identity('READ-OWN'))

    const response = await applicant.get(`${API}/parcels/${parcel.id}`)

    expectStatus(response, 200)
    expect((response.json() as ParcelBody).id).toBe(parcel.id)
  })

  it('reports somebody else’s record as not found, not as forbidden', async () => {
    const parcel = await createParcel(otherApplicant, identity('READ-THEIRS'))

    const response = await applicant.get(`${API}/parcels/${parcel.id}`)

    // The same answer a nonexistent identifier gives: an attacker cannot tell
    // the two apart, so identifiers leak nothing.
    const missing = await applicant.get(`${API}/parcels/${unknownUuid()}`)

    expectError(response, 404, 'not_found')
    expectError(missing, 404, 'not_found')

    const first = response.json() as { error: { code: string; message: string } }
    const second = missing.json() as { error: { code: string; message: string } }
    // Identical apart from the correlation identifier, which is per request.
    expect({ code: first.error.code, message: first.error.message }).toEqual({
      code: second.error.code,
      message: second.error.message,
    })
  })

  it('gives an unauthenticated caller nothing', async () => {
    const parcel = await createParcel(applicant, identity('READ-ANON'))

    const response = await api.app.inject({
      method: 'GET',
      url: `${API}/parcels/${parcel.id}`,
    })

    expectError(response, 401, 'unauthenticated')
  })

  it('lets a reviewer read a record they do not own', async () => {
    const parcel = await createParcel(applicant, identity('READ-REVIEWER'))

    const response = await reviewer.get(`${API}/parcels/${parcel.id}`)

    expectStatus(response, 200)
  })
})

describe('PATCH /parcels/:parcelId', () => {
  it('updates the record and advances the version', async () => {
    const parcel = await createParcel(applicant, {
      ...identity('UPDATE'),
      areaDecimal: '10.0000',
    })

    const response = await applicant.patch(`${API}/parcels/${parcel.id}`, {
      version: parcel.version,
      areaDecimal: '12.2500',
      district: 'Updated District',
    })

    expectStatus(response, 200)
    const updated = response.json() as ParcelBody

    expect(updated.areaDecimal).toBe('12.2500')
    expect(updated.district).toBe('Updated District')
    expect(updated.version).toBeGreaterThan(parcel.version)
  })

  it('refuses a stale version rather than overwriting', async () => {
    const parcel = await createParcel(applicant, identity('STALE'))

    const first = await applicant.patch(`${API}/parcels/${parcel.id}`, {
      version: parcel.version,
      areaDecimal: '20.0000',
    })
    expectStatus(first, 200)

    // A second writer that still holds version 1 must not win.
    const stale = await applicant.patch(`${API}/parcels/${parcel.id}`, {
      version: parcel.version,
      areaDecimal: '99.0000',
    })

    expectError(stale, 409, 'concurrent_modification')

    const current = await applicant.get(`${API}/parcels/${parcel.id}`)
    expect((current.json() as ParcelBody).areaDecimal).toBe('20.0000')
  })

  it('reports another applicant’s record as not found', async () => {
    const parcel = await createParcel(otherApplicant, identity('UPDATE-THEIRS'))

    const response = await applicant.patch(`${API}/parcels/${parcel.id}`, {
      version: parcel.version,
      areaDecimal: '5.0000',
    })

    expectError(response, 404, 'not_found')
  })

  it('refuses a reviewer rewriting a filing', async () => {
    const parcel = await createParcel(applicant, identity('UPDATE-REVIEWER'))

    const response = await reviewer.patch(`${API}/parcels/${parcel.id}`, {
      version: parcel.version,
      areaDecimal: '5.0000',
    })

    // A reviewer can read it, so this is a genuine refusal rather than a
    // disguise: the disagreement belongs in a review decision.
    expectError(response, 403, 'forbidden')
  })

  it('lets an administrator correct a filing they do not own', async () => {
    const parcel = await createParcel(applicant, identity('UPDATE-ADMIN'))

    const response = await admin.patch(`${API}/parcels/${parcel.id}`, {
      version: parcel.version,
      areaDecimal: '7.5000',
    })

    expectStatus(response, 200)
    expect((response.json() as ParcelBody).areaDecimal).toBe('7.5000')
  })
})

describe('parcel lifecycle', () => {
  it('retires a record without deleting anything', async () => {
    const parcel = await createParcel(applicant, identity('RETIRE'))

    const response = await applicant.post(`${API}/parcels/${parcel.id}/retire`, {
      version: parcel.version,
      reason: 'Superseded by a corrected filing.',
    })

    expectStatus(response, 200)
    const retired = response.json() as ParcelBody

    expect(retired.lifecycle).toBe('retired')
    expect(retired.retirementReason).toBe('Superseded by a corrected filing.')
    expect(retired.retiredAt).toEqual(expect.any(String))
    expect(retired.version).toBeGreaterThan(parcel.version)

    // Still readable, still holding its record. Retirement is not deletion.
    const after = await applicant.get(`${API}/parcels/${parcel.id}`)
    expectStatus(after, 200)
    expect((after.json() as ParcelBody).areaDecimal).toBe(parcel.areaDecimal)
  })

  it('requires a reason', async () => {
    const parcel = await createParcel(applicant, identity('RETIRE-NOREASON'))

    const response = await applicant.post(`${API}/parcels/${parcel.id}/retire`, {
      version: parcel.version,
      reason: 'no',
    })

    expectError(response, 422, 'validation_failed')
  })

  it('reports another applicant’s record as not found when retiring', async () => {
    const parcel = await createParcel(otherApplicant, identity('RETIRE-THEIRS'))

    const response = await applicant.post(`${API}/parcels/${parcel.id}/retire`, {
      version: parcel.version,
      reason: 'Not mine to retire at all.',
    })

    expectError(response, 404, 'not_found')
  })

  it('refuses a reinstatement by anyone but an administrator', async () => {
    const parcel = await createParcel(applicant, identity('REINSTATE-OWNER'))
    const retired = await applicant.post(`${API}/parcels/${parcel.id}/retire`, {
      version: parcel.version,
      reason: 'Retired so it can be reinstated.',
    })
    const retiredBody = retired.json() as ParcelBody

    const byOwner = await applicant.post(`${API}/parcels/${parcel.id}/reinstate`, {
      version: retiredBody.version,
      reason: 'Please put it back.',
    })
    expectError(byOwner, 403, 'forbidden')

    const byAdmin = await admin.post(`${API}/parcels/${parcel.id}/reinstate`, {
      version: retiredBody.version,
      reason: 'Reinstated by an administrator.',
    })
    expectStatus(byAdmin, 200)

    const reinstated = byAdmin.json() as ParcelBody
    expect(reinstated.lifecycle).toBe('active')
    expect(reinstated.retiredAt).toBeNull()
    expect(reinstated.retirementReason).toBeNull()
  })

  it('keeps a retired record visible under the retired filter', async () => {
    const parcel = await createParcel(applicant, identity('RETIRED-FILTER'))
    const retired = await applicant.post(`${API}/parcels/${parcel.id}/retire`, {
      version: parcel.version,
      reason: 'Retired so the filter can find it.',
    })
    expectStatus(retired, 200)

    const response = await applicant.get(
      `${API}/parcels?limit=100&lifecycle=retired&khatianNumber=${encodeURIComponent(parcel.khatianNumber)}`,
    )
    expectStatus(response, 200)

    const body = response.json() as { items: ParcelBody[] }
    expect(body.items.map((item) => item.id)).toEqual([parcel.id])
  })
})

describe('deletion', () => {
  it('has no delete endpoint for a parcel', async () => {
    const parcel = await createParcel(applicant, identity('NO-DELETE'))

    const response = await applicant.delete(`${API}/parcels/${parcel.id}`)

    // There is no route: the not-found handler answers, and the record survives.
    expectError(response, 404, 'not_found')
    expectStatus(await applicant.get(`${API}/parcels/${parcel.id}`), 200)
  })
})

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

let sequence = 0
function nextSuffix(): string {
  sequence += 1
  return `${sequence}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * A token unique to this test run.
 *
 * Nothing is deleted between runs, so a fixture written with constant values
 * would collide with the previous run's copy on the record-identity index. Every
 * fixture name therefore carries this token, and every filter is built from it.
 */
const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`

function identity(marker: string): {
  survey: 'RS'
  district: string
  upazila: string
  mouza: string
  jlNumber: string
  khatianNumber: string
} {
  const unique = `${marker}-${RUN}-${nextSuffix()}`
  return {
    survey: 'RS',
    district: `District ${marker} ${RUN}`,
    upazila: `Upazila ${unique}`,
    mouza: `Mouza ${unique}`,
    jlNumber: `JL-${unique}`,
    khatianNumber: `KH-${unique}`,
  }
}

/** The district every `identity(marker)` fixture shares, as a query filter. */
function districtFilter(marker: string): string {
  return `district=${encodeURIComponent(`District ${marker} ${RUN}`)}`
}

function minimalParcel(): Record<string, unknown> {
  const suffix = nextSuffix()
  return {
    survey: 'RS',
    khatianNumber: `KH-MIN-${suffix}`,
    mouza: 'Minimal Mouza',
    jlNumber: `JL-MIN-${suffix}`,
    upazila: 'Minimal Upazila',
    district: 'Minimal District',
    areaDecimal: '1.0000',
    shareNumerator: 1,
    shareDenominator: 1,
    dagNumbers: [],
  }
}
