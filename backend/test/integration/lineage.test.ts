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
  type TestApi,
  type TestClient,
} from '../helpers/api.js'

/**
 * Parcel lineage: how records continue, split, and merge across surveys.
 *
 * The property that matters most is that a *proposed* link cannot quietly
 * become a verified one: an applicant may only record an unverified or
 * illustrative chain, and confirming is a reviewer action that must name the
 * evidence it rests on.
 */

let api: TestApi
let applicant: TestClient
let otherApplicant: TestClient
let reviewer: TestClient
let admin: TestClient

beforeAll(async () => {
  api = await createTestApi()

  applicant = await signIn(api.app, await createAccount(api.database, 'applicant'))
  otherApplicant = await signIn(api.app, await createAccount(api.database, 'applicant'))
  reviewer = await signIn(api.app, await createAccount(api.database, 'reviewer'))
  admin = await signIn(api.app, await createAccount(api.database, 'admin'))
})

afterAll(async () => {
  await api.close()
})

interface LinkBody {
  id: string
  fromParcelId: string
  toParcelId: string
  relation: string
  certainty: string
  evidenceReference: string | null
  note: string | null
  createdAt: string
}

interface ArithmeticBody {
  ruleCode: string
  relation: string
  observedParts: string[]
  observedTotal: string
  expectedTotal: string
  exactlyEqual: boolean
  explanation: string
}

async function link(
  client: TestClient,
  from: string,
  body: {
    toParcelId: string
    relation: string
    certainty?: string
    evidenceReference?: string | null
    note?: string | null
  },
): Promise<{ link: LinkBody; arithmetic: ArithmeticBody | null }> {
  const response = await client.post(`${API}/parcels/${from}/lineage`, body)
  expectStatus(response, 201)
  return response.json() as { link: LinkBody; arithmetic: ArithmeticBody | null }
}

describe('POST /parcels/:parcelId/lineage', () => {
  it('records a link an applicant proposes, as unverified', async () => {
    const from = await createParcel(applicant)
    const to = await createParcel(applicant)

    const created = await link(applicant, from.id, {
      toParcelId: to.id,
      relation: 'continued',
      note: 'Same land, new survey.',
    })

    expect(created.link.fromParcelId).toBe(from.id)
    expect(created.link.toParcelId).toBe(to.id)
    expect(created.link.relation).toBe('continued')
    // The default certainty is a proposal, not a claim of fact.
    expect(created.link.certainty).toBe('unverified')
    expect(created.link.note).toBe('Same land, new survey.')
    // No area relationship exists for a continuation, so no note is invented.
    expect(created.arithmetic).toBeNull()
  })

  it('accepts an illustrative link from an applicant', async () => {
    const from = await createParcel(applicant)
    const to = await createParcel(applicant)

    const created = await link(applicant, from.id, {
      toParcelId: to.id,
      relation: 'continued',
      certainty: 'illustrative',
    })

    expect(created.link.certainty).toBe('illustrative')
  })

  it('refuses an applicant recording a confirmed link', async () => {
    const from = await createParcel(applicant)
    const to = await createParcel(applicant)

    const response = await applicant.post(`${API}/parcels/${from.id}/lineage`, {
      toParcelId: to.id,
      relation: 'continued',
      certainty: 'confirmed',
      evidenceReference: 'Khatian 104, page 1.',
    })

    // Not even with evidence: confirming is a reviewer judgement.
    expectError(response, 403, 'forbidden')
  })

  it('refuses a confirmed link with no evidence, even from a reviewer', async () => {
    const from = await createParcel(applicant)
    const to = await createParcel(applicant)

    const response = await reviewer.post(`${API}/parcels/${from.id}/lineage`, {
      toParcelId: to.id,
      relation: 'continued',
      certainty: 'confirmed',
    })

    expectError(response, 400, 'bad_request')
  })

  it('lets a reviewer confirm a link that names its evidence', async () => {
    const from = await createParcel(applicant)
    const to = await createParcel(applicant)

    const created = await link(reviewer, from.id, {
      toParcelId: to.id,
      relation: 'continued',
      certainty: 'confirmed',
      evidenceReference: 'Khatian 104, page 1, entry 3.',
    })

    expect(created.link.certainty).toBe('confirmed')
    expect(created.link.evidenceReference).toBe('Khatian 104, page 1, entry 3.')
  })

  it('refuses a parcel linked to itself', async () => {
    const parcel = await createParcel(applicant)

    const response = await applicant.post(`${API}/parcels/${parcel.id}/lineage`, {
      toParcelId: parcel.id,
      relation: 'continued',
    })

    const body = expectError(response, 400, 'bad_request')
    expect(body.error.message).toContain('itself')
  })

  it('refuses the same link twice', async () => {
    const from = await createParcel(applicant)
    const to = await createParcel(applicant)

    await link(applicant, from.id, { toParcelId: to.id, relation: 'continued' })

    const duplicate = await applicant.post(`${API}/parcels/${from.id}/lineage`, {
      toParcelId: to.id,
      relation: 'continued',
    })

    expectError(duplicate, 409, 'conflict')
  })

  it('reports a parcel the caller cannot see as not found', async () => {
    const mine = await createParcel(applicant)
    const theirs = await createParcel(otherApplicant)

    const response = await applicant.post(`${API}/parcels/${mine.id}/lineage`, {
      toParcelId: theirs.id,
      relation: 'continued',
    })

    // An invisible endpoint is indistinguishable from a nonexistent one.
    expectError(response, 404, 'not_found')
  })

  it('requires authentication and a CSRF token', async () => {
    const from = await createParcel(applicant)
    const to = await createParcel(applicant)

    const anonymous = await api.app.inject({
      method: 'POST',
      url: `${API}/parcels/${from.id}/lineage`,
      headers: { 'content-type': 'application/json' },
      payload: { toParcelId: to.id, relation: 'continued' },
    })
    expectError(anonymous, 401, 'unauthenticated')

    const noCsrf = await applicant.post(
      `${API}/parcels/${from.id}/lineage`,
      { toParcelId: to.id, relation: 'continued' },
      { withCsrf: false },
    )
    expectError(noCsrf, 403, 'forbidden')
  })
})

describe('lineage cycles', () => {
  it('refuses a link that closes a three-node loop, leaving the graph acyclic', async () => {
    const a = await createParcel(applicant)
    const b = await createParcel(applicant)
    const c = await createParcel(applicant)

    await link(admin, a.id, { toParcelId: b.id, relation: 'continued' })
    await link(admin, b.id, { toParcelId: c.id, relation: 'continued' })

    const closing = await admin.post(`${API}/parcels/${c.id}/lineage`, {
      toParcelId: a.id,
      relation: 'continued',
    })

    expectError(closing, 400, 'bad_request')

    // The rejected insert was rolled back with its transaction, so nothing
    // points back at the start.
    const listing = await admin.get(`${API}/parcels/${c.id}/lineage`)
    expectStatus(listing, 200)
    expect((listing.json() as { outgoing: LinkBody[] }).outgoing).toEqual([])
  })

  it('refuses a two-node loop', async () => {
    const a = await createParcel(applicant)
    const b = await createParcel(applicant)

    await link(admin, a.id, { toParcelId: b.id, relation: 'continued' })

    const back = await admin.post(`${API}/parcels/${b.id}/lineage`, {
      toParcelId: a.id,
      relation: 'continued',
    })

    expectError(back, 400, 'bad_request')
  })
})

describe('split and merge arithmetic', () => {
  it('reports that a split adds up, without calling it proof', async () => {
    const parent = await createParcel(applicant, { areaDecimal: '100.0000' })
    const firstChild = await createParcel(applicant, { areaDecimal: '60.0000' })
    const secondChild = await createParcel(applicant, { areaDecimal: '40.0000' })

    await link(admin, parent.id, { toParcelId: firstChild.id, relation: 'split' })
    const completed = await link(admin, parent.id, {
      toParcelId: secondChild.id,
      relation: 'split',
    })

    const note = completed.arithmetic
    expect(note).not.toBeNull()
    expect(note?.ruleCode).toBe('LINEAGE_SPLIT_AREA_SUM')
    expect(note?.observedParts).toEqual(['40.0000', '60.0000'])
    expect(note?.observedTotal).toBe('100')
    expect(note?.expectedTotal).toBe('100')
    expect(note?.exactlyEqual).toBe(true)

    // The wording never presents arithmetic agreement as legal continuity.
    expect(note?.explanation).toContain('consistency observation only')
    expect(note?.explanation).not.toContain('ownership transferred')
  })

  it('reports a split that does not add up, as an observation', async () => {
    const parent = await createParcel(applicant, { areaDecimal: '100.0000' })
    const firstChild = await createParcel(applicant, { areaDecimal: '60.0000' })
    const secondChild = await createParcel(applicant, { areaDecimal: '30.0000' })

    await link(admin, parent.id, { toParcelId: firstChild.id, relation: 'split' })
    const completed = await link(admin, parent.id, {
      toParcelId: secondChild.id,
      relation: 'split',
    })

    expect(completed.arithmetic?.exactlyEqual).toBe(false)
    expect(completed.arithmetic?.observedTotal).toBe('90')
    expect(completed.arithmetic?.expectedTotal).toBe('100')
  })

  it('compares the merged parts against the parcel they merge into', async () => {
    const firstPart = await createParcel(applicant, { areaDecimal: '50.0000' })
    const secondPart = await createParcel(applicant, { areaDecimal: '50.0000' })
    const merged = await createParcel(applicant, { areaDecimal: '100.0000' })

    await link(admin, firstPart.id, { toParcelId: merged.id, relation: 'merge' })
    const completed = await link(admin, secondPart.id, {
      toParcelId: merged.id,
      relation: 'merge',
    })

    expect(completed.arithmetic?.ruleCode).toBe('LINEAGE_MERGE_AREA_SUM')
    expect(completed.arithmetic?.observedParts).toEqual(['50.0000', '50.0000'])
    expect(completed.arithmetic?.observedTotal).toBe('100')
    expect(completed.arithmetic?.exactlyEqual).toBe(true)
  })
})

describe('GET /parcels/:parcelId/lineage', () => {
  it('returns links in both directions', async () => {
    const middle = await createParcel(applicant)
    const before = await createParcel(applicant)
    const after = await createParcel(applicant)

    await link(admin, before.id, { toParcelId: middle.id, relation: 'continued' })
    await link(admin, middle.id, { toParcelId: after.id, relation: 'continued' })

    const response = await applicant.get(`${API}/parcels/${middle.id}/lineage`)

    expectStatus(response, 200)
    const body = response.json() as {
      outgoing: LinkBody[]
      incoming: LinkBody[]
      arithmetic: ArithmeticBody[]
    }

    expect(body.outgoing.map((item) => item.toParcelId)).toEqual([after.id])
    expect(body.incoming.map((item) => item.fromParcelId)).toEqual([before.id])
    // A continuation has no expected area relationship.
    expect(body.arithmetic).toEqual([])
  })

  it('reports another account’s parcel as not found', async () => {
    const theirs = await createParcel(otherApplicant)

    const response = await applicant.get(`${API}/parcels/${theirs.id}/lineage`)

    expectError(response, 404, 'not_found')
  })
})

describe('POST /parcels/:parcelId/lineage/:lineageId/certainty', () => {
  it('refuses an applicant changing how certain a link is', async () => {
    const from = await createParcel(applicant)
    const to = await createParcel(applicant)
    const created = await link(applicant, from.id, {
      toParcelId: to.id,
      relation: 'continued',
    })

    const response = await applicant.post(
      `${API}/parcels/${from.id}/lineage/${created.link.id}/certainty`,
      { certainty: 'confirmed', evidenceReference: 'Trust me.' },
    )

    expectError(response, 403, 'forbidden')
  })

  it('requires evidence before a reviewer can confirm', async () => {
    const from = await createParcel(applicant)
    const to = await createParcel(applicant)
    const created = await link(applicant, from.id, {
      toParcelId: to.id,
      relation: 'continued',
    })

    const response = await reviewer.post(
      `${API}/parcels/${from.id}/lineage/${created.link.id}/certainty`,
      { certainty: 'confirmed' },
    )

    expectError(response, 400, 'bad_request')
  })

  it('lets a reviewer confirm a link and records the evidence', async () => {
    const from = await createParcel(applicant)
    const to = await createParcel(applicant)
    const created = await link(applicant, from.id, {
      toParcelId: to.id,
      relation: 'continued',
    })

    const response = await reviewer.post(
      `${API}/parcels/${from.id}/lineage/${created.link.id}/certainty`,
      { certainty: 'confirmed', evidenceReference: 'RS khatian 104, page 2.' },
    )

    expectStatus(response, 200)
    const updated = response.json() as LinkBody

    expect(updated.certainty).toBe('confirmed')
    expect(updated.evidenceReference).toBe('RS khatian 104, page 2.')

    // The change is visible on the link itself, not only in the audit trail.
    const listing = await reviewer.get(`${API}/parcels/${from.id}/lineage`)
    expectStatus(listing, 200)
    const links = (listing.json() as { outgoing: LinkBody[] }).outgoing
    expect(links.find((item) => item.id === created.link.id)?.certainty).toBe('confirmed')
  })

  it('reports an unknown link as not found', async () => {
    const from = await createParcel(applicant)

    const response = await reviewer.post(
      `${API}/parcels/${from.id}/lineage/${unknownUuid()}/certainty`,
      { certainty: 'unverified' },
    )

    expectError(response, 404, 'not_found')
  })

  it('reports a link that belongs to a different parcel as not found', async () => {
    const from = await createParcel(applicant)
    const to = await createParcel(applicant)
    const unrelated = await createParcel(applicant)
    const created = await link(applicant, from.id, {
      toParcelId: to.id,
      relation: 'continued',
    })

    const response = await reviewer.post(
      `${API}/parcels/${unrelated.id}/lineage/${created.link.id}/certainty`,
      { certainty: 'illustrative' },
    )

    // The link exists, but not on the parcel named in the path.
    expectError(response, 404, 'not_found')
  })
})
