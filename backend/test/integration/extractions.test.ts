import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  API,
  createAccount,
  createDocument,
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
import { closeTestDatabase } from '../helpers/database.js'

/**
 * Extracted values: where a reading came from and what it means.
 *
 * The property under test is provenance honesty. A value a person typed has no
 * provider and no timestamp, and says so; nothing is ever attributed to a
 * provider that did not produce it, and a reading is never adjusted at the
 * moment it is recorded.
 */

let api: TestApi
let applicant: TestClient
let otherApplicant: TestClient
let reviewer: TestClient

beforeAll(async () => {
  api = await createTestApi()

  applicant = await signIn(api.app, await createAccount(api.database, 'applicant'))
  otherApplicant = await signIn(api.app, await createAccount(api.database, 'applicant'))
  reviewer = await signIn(api.app, await createAccount(api.database, 'reviewer'))
})

afterAll(async () => {
  await api.close()
  await closeTestDatabase()
})

interface ExtractionBody {
  id: string
  parcelId: string
  sourceDocumentId: string | null
  pageId: string | null
  field: string
  recordedValue: string
  reviewedValue: string | null
  reviewStatus: string
  confidence: string | null
  isUnclear: boolean
  pageReference: string | null
  boundingBox: unknown
  provider: string | null
  providerModel: string | null
  origin: string
  extractedAt: string | null
  reviewedBy: string | null
  version: number
}

async function recordManual(
  client: TestClient,
  parcelId: string,
  field: string,
  recordedValue: string,
  extra: Record<string, unknown> = {},
): Promise<ExtractionBody> {
  const response = await client.post(`${API}/parcels/${parcelId}/extractions`, {
    field,
    recordedValue,
    ...extra,
  })
  expectStatus(response, 201)
  return response.json() as ExtractionBody
}

describe('POST /parcels/:parcelId/extractions', () => {
  it('records a hand-read value with no provider and no timestamp', async () => {
    const parcel = await createParcel(applicant)

    const extraction = await recordManual(applicant, parcel.id, 'area', '120.5000', {
      pageReference: 'তফসিল, ঘর ৩',
    })

    expect(extraction.parcelId).toBe(parcel.id)
    // Not degraded: a manual entry is a normal, first-class reading.
    expect(extraction.origin).toBe('manual_entry')
    expect(extraction.provider).toBeNull()
    expect(extraction.providerModel).toBeNull()
    expect(extraction.extractedAt).toBeNull()
    expect(extraction.sourceDocumentId).toBeNull()
    expect(extraction.pageId).toBeNull()

    // Nothing was measured, so no confidence and no region are invented.
    expect(extraction.confidence).toBeNull()
    expect(extraction.boundingBox).toBeNull()

    expect(extraction.recordedValue).toBe('120.5000')
    expect(extraction.reviewedValue).toBeNull()
    expect(extraction.reviewStatus).toBe('pending')
    expect(extraction.isUnclear).toBe(false)
    expect(extraction.pageReference).toBe('তফসিল, ঘর ৩')
    expect(extraction.version).toBe(1)
  })

  it('accepts an entry marked unclear with an empty value', async () => {
    const parcel = await createParcel(applicant)

    const extraction = await recordManual(applicant, parcel.id, 'share', '', {
      isUnclear: true,
    })

    expect(extraction.isUnclear).toBe(true)
    // An unreadable reading is recorded as unreadable, not guessed at.
    expect(extraction.recordedValue).toBe('')
    expect(extraction.reviewStatus).toBe('unclear')
  })

  it('refuses an empty value that is not marked unclear', async () => {
    const parcel = await createParcel(applicant)

    const response = await applicant.post(`${API}/parcels/${parcel.id}/extractions`, {
      field: 'area',
      recordedValue: '   ',
    })

    // Well-formed enough for the schema, but semantically empty: the service
    // refuses it with the explanation rather than storing a blank reading.
    expectError(response, 400, 'bad_request')
  })

  it('refuses a field outside the controlled vocabulary', async () => {
    const parcel = await createParcel(applicant)

    const response = await applicant.post(`${API}/parcels/${parcel.id}/extractions`, {
      field: 'mutation_number',
      recordedValue: '1412',
    })

    expectError(response, 422, 'validation_failed')
  })

  it('reports another applicant’s parcel as not found', async () => {
    const theirs = await createParcel(otherApplicant)

    const response = await applicant.post(`${API}/parcels/${theirs.id}/extractions`, {
      field: 'area',
      recordedValue: '1.0000',
    })

    expectError(response, 404, 'not_found')
  })

  it('requires authentication and a CSRF token', async () => {
    const parcel = await createParcel(applicant)

    const anonymous = await api.app.inject({
      method: 'POST',
      url: `${API}/parcels/${parcel.id}/extractions`,
      headers: { 'content-type': 'application/json' },
      payload: { field: 'area', recordedValue: '1.0000' },
    })
    expectError(anonymous, 401, 'unauthenticated')

    const noCsrf = await applicant.post(
      `${API}/parcels/${parcel.id}/extractions`,
      { field: 'area', recordedValue: '1.0000' },
      { withCsrf: false },
    )
    expectError(noCsrf, 403, 'forbidden')
  })
})

describe('GET /parcels/:parcelId/extractions', () => {
  it('lists every reading in order, old and new', async () => {
    const parcel = await createParcel(applicant)
    const first = await recordManual(applicant, parcel.id, 'khatian', '104')
    const second = await recordManual(applicant, parcel.id, 'dag', '341')

    const response = await applicant.get(`${API}/parcels/${parcel.id}/extractions`)

    expectStatus(response, 200)
    const items = (response.json() as { items: ExtractionBody[] }).items
    expect(items.map((item) => item.id)).toEqual([first.id, second.id])
  })

  it('reports another applicant’s parcel as not found', async () => {
    const theirs = await createParcel(otherApplicant)

    const response = await applicant.get(`${API}/parcels/${theirs.id}/extractions`)

    expectError(response, 404, 'not_found')
  })
})

describe('GET /extractions/:extractionId', () => {
  it('returns a reading to the owner of its parcel', async () => {
    const parcel = await createParcel(applicant)
    const extraction = await recordManual(applicant, parcel.id, 'area', '99.0000')

    const response = await applicant.get(`${API}/extractions/${extraction.id}`)

    expectStatus(response, 200)
    expect((response.json() as ExtractionBody).id).toBe(extraction.id)
  })

  it('reports a reading on somebody else’s parcel as not found', async () => {
    const theirs = await createParcel(otherApplicant)
    const extraction = await recordManual(otherApplicant, theirs.id, 'area', '1.0000')

    const response = await applicant.get(`${API}/extractions/${extraction.id}`)

    expectError(response, 404, 'not_found')
  })

  it('reports an unknown identifier as not found', async () => {
    const response = await applicant.get(`${API}/extractions/${unknownUuid()}`)

    expectError(response, 404, 'not_found')
  })

  it('lets a reviewer read a reading on a parcel they do not own', async () => {
    const parcel = await createParcel(applicant)
    const extraction = await recordManual(applicant, parcel.id, 'mouza', 'শালবন')

    const response = await reviewer.get(`${API}/extractions/${extraction.id}`)

    expectStatus(response, 200)
    expect((response.json() as ExtractionBody).recordedValue).toBe('শালবন')
  })
})

describe('manual entry without a source document', () => {
  it('keeps provenance explicit: no document, but a document is still usable', async () => {
    const parcel: ParcelBody = await createParcel(applicant)
    // A document exists and is unrelated to the manual entry; the entry must not
    // silently attach itself to it.
    const document = await createDocument(applicant)

    const extraction = await recordManual(applicant, parcel.id, 'owner', 'মোঃ রহিম')

    expect(extraction.sourceDocumentId).toBeNull()
    expect(extraction.provider).toBeNull()

    const listed = await applicant.get(`${API}/parcels/${parcel.id}/extractions`)
    expectStatus(listed, 200)
    const items = (listed.json() as { items: ExtractionBody[] }).items
    expect(items.every((item) => item.sourceDocumentId !== document.id)).toBe(true)
  })
})
