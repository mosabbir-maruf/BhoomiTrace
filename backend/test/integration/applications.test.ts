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
import { closeTestDatabase } from '../helpers/database.js'

/**
 * Applications: filing a record, following it, and who may move it.
 *
 * Three properties matter here:
 *
 * 1. A filing belongs to its applicant. It is visible and editable only to
 *    them — and only while it is still a draft — while a reviewer may read every
 *    filing but never rewrite one.
 * 2. A status is never set by a client. A caller asks for a transition, and the
 *    service decides whether that transition exists from the state the row is
 *    actually in and whether the caller's role may perform it.
 * 3. Every change is version-aware and lands in the append-only audit trail,
 *    which is also where the timeline comes from.
 *
 * Nothing here asserts that any state is a government decision; the states are
 * the tracker's own vocabulary.
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
  await closeTestDatabase()
})

interface ApplicationBody {
  id: string
  ownerId: string
  trackingNumber: string | null
  type: string
  status: string
  district: string
  upazila: string
  mouza: string
  khatianNumber: string
  dagNumber: string
  areaDecimal: string | null
  share: string | null
  parcelId: string | null
  declaredDocuments: string[]
  submittedAt: string | null
  decidedAt: string | null
  decisionNote: string | null
  nextStep: string | null
  deadline: string | null
  origin: string
  version: number
  createdAt: string
  updatedAt: string
}

interface DetailBody extends ApplicationBody {
  today: string
  timeline: { date: string; title: string; note?: string }[]
}

let sequence = 0

/** A fresh draft body: unique mouza/khatian so runs never collide. */
function draftBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  sequence += 1
  return {
    type: 'mutation',
    district: 'ঢাকা',
    upazila: 'সাভার',
    mouza: `ApplicationsMouza-${sequence}`,
    khatianNumber: `${900 + sequence}`,
    dagNumber: `${1200 + sequence}`,
    ...overrides,
  }
}

async function createApplication(
  client: TestClient,
  overrides: Record<string, unknown> = {},
): Promise<ApplicationBody> {
  const response = await client.post(`${API}/applications`, draftBody(overrides))
  expectStatus(response, 201)
  return response.json() as ApplicationBody
}

/** Creates a draft and submits it, returning the submitted application. */
async function submittedApplication(
  client: TestClient = applicant,
): Promise<ApplicationBody> {
  const draft = await createApplication(client)
  const response = await client.post(`${API}/applications/${draft.id}/transitions`, {
    version: draft.version,
    toStatus: 'submitted',
  })
  expectStatus(response, 200)
  return response.json() as ApplicationBody
}

/** One requested transition, optionally carrying its side-effect fields. */
interface TransitionStep {
  toStatus: string
  note?: string
  nextStep?: string
  deadline?: string
}

/** Moves an application through the given transitions, one at a time. */
async function advance(
  client: TestClient,
  application: ApplicationBody,
  ...steps: (string | TransitionStep)[]
): Promise<ApplicationBody> {
  let current = application
  for (const step of steps) {
    const body = typeof step === 'string' ? { toStatus: step } : step
    const response = await client.post(
      `${API}/applications/${current.id}/transitions`,
      { version: current.version, ...body },
    )
    expectStatus(response, 200)
    current = response.json() as ApplicationBody
  }
  return current
}

/* -------------------------------------------------------------------------- */
/* Creating                                                                    */
/* -------------------------------------------------------------------------- */

describe('POST /applications', () => {
  it('records a draft owned by the caller, with no tracking number yet', async () => {
    const application = await createApplication(applicant, {
      areaDecimal: '11.0000',
      share: '1/3',
      documents: ['deed', 'id', 'khatian'],
    })

    expect(application.status).toBe('draft')
    expect(application.trackingNumber).toBeNull()
    expect(application.submittedAt).toBeNull()
    expect(application.decidedAt).toBeNull()
    expect(application.ownerId).toBe(applicant.account.id)
    expect(application.origin).toBe('user_created')
    expect(application.version).toBe(1)
    // The exact values survive the round trip unchanged.
    expect(application.areaDecimal).toBe('11.0000')
    expect(application.share).toBe('1/3')
    expect(application.declaredDocuments).toEqual(['deed', 'id', 'khatian'])
  })

  it('leaves an unknown area and share unset rather than guessing zeros', async () => {
    const application = await createApplication(applicant)

    expect(application.areaDecimal).toBeNull()
    expect(application.share).toBeNull()
    expect(application.declaredDocuments).toEqual([])
  })

  it('refuses a reviewer, because a reviewer does not file', async () => {
    const response = await reviewer.post(`${API}/applications`, draftBody())

    expectError(response, 403, 'forbidden')
  })

  it('lets an administrator file on behalf of another account', async () => {
    const response = await admin.post(
      `${API}/applications`,
      draftBody({ ownerId: otherApplicant.account.id }),
    )
    expectStatus(response, 201)
    const application = response.json() as ApplicationBody

    // The filing belongs to the named account, not to the administrator.
    expect(application.ownerId).toBe(otherApplicant.account.id)

    // And it is that account, not the administrator, who can see it.
    expectStatus(await otherApplicant.get(`${API}/applications/${application.id}`), 200)
  })

  it('refuses an unknown owner account', async () => {
    const response = await admin.post(
      `${API}/applications`,
      draftBody({ ownerId: unknownUuid() }),
    )

    expectError(response, 404, 'not_found')
  })

  it('refuses an applicant trying to name an owner other than themselves', async () => {
    // An `ownerId` in a body is a client-controlled field, so it is honoured
    // only for the one role the platform reserves for acting on behalf of
    // somebody else. For an applicant it is ignored, and the filing is theirs.
    const application = await createApplication(applicant, {
      ownerId: otherApplicant.account.id,
    })

    expect(application.ownerId).toBe(applicant.account.id)
  })

  it('validates the declared checklist codes and the exact values', async () => {
    const unknownCode = await applicant.post(
      `${API}/applications`,
      draftBody({ documents: ['deed', 'invented_document'] }),
    )
    expectError(unknownCode, 422, 'validation_failed')

    const badShare = await applicant.post(
      `${API}/applications`,
      draftBody({ share: 'half' }),
    )
    expectError(badShare, 422, 'validation_failed')

    const badArea = await applicant.post(
      `${API}/applications`,
      draftBody({ areaDecimal: '1.23456' }),
    )
    expectError(badArea, 422, 'validation_failed')

    const missingField = await applicant.post(`${API}/applications`, {
      type: 'mutation',
      district: 'ঢাকা',
      upazila: 'সাভার',
      mouza: 'X',
      khatianNumber: '1',
      // dagNumber missing
    })
    expectError(missingField, 422, 'validation_failed')
  })

  it('refuses a parcel the filing’s owner cannot see', async () => {
    const theirs = await createParcel(otherApplicant)

    const response = await applicant.post(
      `${API}/applications`,
      draftBody({ parcelId: theirs.id }),
    )

    expectError(response, 404, 'not_found')
  })

  it('accepts a parcel its owner can see', async () => {
    const parcel = await createParcel(applicant)

    const application = await createApplication(applicant, { parcelId: parcel.id })

    expect(application.parcelId).toBe(parcel.id)
  })

  it('requires authentication', async () => {
    const response = await api.app.inject({
      method: 'POST',
      url: `${API}/applications`,
      headers: { 'content-type': 'application/json' },
      payload: draftBody(),
    })

    expectError(response, 401, 'unauthenticated')
  })
})

/* -------------------------------------------------------------------------- */
/* Reading                                                                     */
/* -------------------------------------------------------------------------- */

describe('GET /applications', () => {
  it('shows an applicant only their own filings', async () => {
    const mine = await createApplication(applicant)
    const theirs = await createApplication(otherApplicant)

    const response = await applicant.get(`${API}/applications?limit=100`)
    expectStatus(response, 200)
    const ids = (response.json() as { items: ApplicationBody[] }).items.map(
      (item) => item.id,
    )

    expect(ids).toContain(mine.id)
    expect(ids).not.toContain(theirs.id)
  })

  it('shows a reviewer every filing', async () => {
    const mine = await createApplication(applicant)

    const response = await reviewer.get(`${API}/applications?limit=100`)
    expectStatus(response, 200)
    const ids = (response.json() as { items: ApplicationBody[] }).items.map(
      (item) => item.id,
    )

    expect(ids).toContain(mine.id)
  })

  it('filters by status and type', async () => {
    const submitted = await submittedApplication()
    const draft = await createApplication(applicant, { type: 'certified_copy' })

    const submittedOnly = await applicant.get(`${API}/applications?status=submitted&limit=100`)
    expectStatus(submittedOnly, 200)
    const submittedIds = (submittedOnly.json() as { items: ApplicationBody[] }).items.map(
      (item) => item.id,
    )
    expect(submittedIds).toContain(submitted.id)
    expect(submittedIds).not.toContain(draft.id)

    const copies = await applicant.get(`${API}/applications?type=certified_copy&limit=100`)
    expectStatus(copies, 200)
    const copyIds = (copies.json() as { items: ApplicationBody[] }).items.map(
      (item) => item.id,
    )
    expect(copyIds).toContain(draft.id)
    expect(copyIds).not.toContain(submitted.id)
  })
})

describe('GET /applications/:applicationId', () => {
  it('returns the filing with its timeline and the server’s date', async () => {
    const application = await createApplication(applicant)

    const response = await applicant.get(`${API}/applications/${application.id}`)
    expectStatus(response, 200)
    const detail = response.json() as DetailBody

    expect(detail.id).toBe(application.id)
    expect(detail.today).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(detail.timeline.length).toBeGreaterThan(0)
    expect(detail.timeline[0]?.title).toBe('Application created')
  })

  it('hides another applicant’s filing behind a 404', async () => {
    const application = await createApplication(applicant)

    expectError(
      await otherApplicant.get(`${API}/applications/${application.id}`),
      404,
      'not_found',
    )
    expectError(
      await applicant.get(`${API}/applications/${unknownUuid()}`),
      404,
      'not_found',
    )
  })

  it('lets a reviewer read a filing they did not create', async () => {
    const application = await createApplication(applicant)

    const response = await reviewer.get(`${API}/applications/${application.id}`)

    expectStatus(response, 200)
    expect((response.json() as ApplicationBody).id).toBe(application.id)
  })
})

/* -------------------------------------------------------------------------- */
/* Updating                                                                    */
/* -------------------------------------------------------------------------- */

describe('PATCH /applications/:applicationId', () => {
  it('updates a draft, bumps the version, and records the change', async () => {
    const application = await createApplication(applicant)

    const response = await applicant.patch(`${API}/applications/${application.id}`, {
      version: application.version,
      areaDecimal: '12.5000',
      share: '2/5',
      documents: ['deed', 'id', 'khatian', 'tax'],
    })
    expectStatus(response, 200)
    const updated = response.json() as ApplicationBody

    expect(updated.areaDecimal).toBe('12.5000')
    expect(updated.share).toBe('2/5')
    expect(updated.declaredDocuments).toEqual(['deed', 'id', 'khatian', 'tax'])
    expect(updated.version).toBe(application.version + 1)

    const events = await admin.get(
      `${API}/audit-events?action=application.updated&entityId=${application.id}&limit=5`,
    )
    expectStatus(events, 200)
    expect((events.json() as { items: unknown[] }).items.length).toBeGreaterThan(0)
  })

  it('clears an area or share that is explicitly set to null', async () => {
    const application = await createApplication(applicant, {
      areaDecimal: '1.0000',
      share: '1/2',
    })

    const response = await applicant.patch(`${API}/applications/${application.id}`, {
      version: application.version,
      areaDecimal: null,
      share: null,
    })
    expectStatus(response, 200)
    const updated = response.json() as ApplicationBody

    expect(updated.areaDecimal).toBeNull()
    expect(updated.share).toBeNull()
  })

  it('refuses a stale version rather than overwriting a newer change', async () => {
    const application = await createApplication(applicant)
    expectStatus(
      await applicant.patch(`${API}/applications/${application.id}`, {
        version: application.version,
        mouza: 'First change',
      }),
      200,
    )

    const stale = await applicant.patch(`${API}/applications/${application.id}`, {
      version: application.version,
      mouza: 'Second change',
    })

    expectError(stale, 409, 'concurrent_modification')
  })

  it('refuses a reviewer outright and an applicant once it is submitted', async () => {
    const application = await submittedApplication()

    expectError(
      await reviewer.patch(`${API}/applications/${application.id}`, {
        version: application.version,
        mouza: 'Rewritten by a reviewer',
      }),
      403,
      'forbidden',
    )

    expectError(
      await applicant.patch(`${API}/applications/${application.id}`, {
        version: application.version,
        mouza: 'Edited after submission',
      }),
      403,
      'forbidden',
    )
  })

  it('lets an administrator correct a submitted filing', async () => {
    const application = await submittedApplication()

    const response = await admin.patch(`${API}/applications/${application.id}`, {
      version: application.version,
      mouza: 'Corrected by an administrator',
    })

    expectStatus(response, 200)
    expect((response.json() as ApplicationBody).mouza).toBe(
      'Corrected by an administrator',
    )
  })

  it('reports somebody else’s filing as not found', async () => {
    const application = await createApplication(applicant)

    expectError(
      await otherApplicant.patch(`${API}/applications/${application.id}`, {
        version: application.version,
        mouza: 'Not mine',
      }),
      404,
      'not_found',
    )
  })
})

/* -------------------------------------------------------------------------- */
/* Transitions                                                                 */
/* -------------------------------------------------------------------------- */

describe('POST /applications/:applicationId/transitions', () => {
  it('assigns a tracking number and a submission time on submit', async () => {
    const draft = await createApplication(applicant)

    const response = await applicant.post(
      `${API}/applications/${draft.id}/transitions`,
      { version: draft.version, toStatus: 'submitted' },
    )
    expectStatus(response, 200)
    const submitted = response.json() as ApplicationBody

    expect(submitted.status).toBe('submitted')
    expect(submitted.trackingNumber).toMatch(/^BT-\d{4}-\d{5,}$/)
    expect(submitted.submittedAt).toEqual(expect.any(String))
  })

  it('gives each submission its own reference number', async () => {
    const first = await submittedApplication()
    const second = await submittedApplication()

    expect(first.trackingNumber).not.toBe(second.trackingNumber)
  })

  it('records every step in the timeline, in order', async () => {
    const submitted = await submittedApplication()
    const underReview = await advance(reviewer, submitted, 'under_review')
    await advance(reviewer, underReview, {
      toStatus: 'rejected',
      note: 'নথিতে দাগ নম্বর মেলেনি।',
    })

    const response = await applicant.get(`${API}/applications/${submitted.id}`)
    expectStatus(response, 200)
    const timeline = (response.json() as DetailBody).timeline

    const titles = timeline.map((event) => event.title)
    expect(titles).toContain('Application created')
    expect(titles).toContain('Status: draft → submitted')
    expect(titles).toContain('Status: submitted → under_review')
    expect(titles).toContain('Status: under_review → rejected')
  })

  it('refuses a transition that does not exist from the current state', async () => {
    const draft = await createApplication(applicant)

    // A draft cannot jump straight to a settled state.
    const response = await applicant.post(
      `${API}/applications/${draft.id}/transitions`,
      { version: draft.version, toStatus: 'approved' },
    )

    const error = expectError(response, 409, 'invalid_transition')
    expect(error.error.details).toMatchObject({ from: 'draft', requested: 'approved' })
  })

  it('refuses a role that may not perform the transition', async () => {
    const draft = await createApplication(applicant)

    // A reviewer does not submit somebody else's draft.
    expectError(
      await reviewer.post(`${API}/applications/${draft.id}/transitions`, {
        version: draft.version,
        toStatus: 'submitted',
      }),
      403,
      'forbidden',
    )

    const submitted = await submittedApplication()
    // An applicant does not drive a review.
    expectError(
      await applicant.post(`${API}/applications/${submitted.id}/transitions`, {
        version: submitted.version,
        toStatus: 'under_review',
      }),
      403,
      'forbidden',
    )
  })

  it('requires a reason to reject, and records the decision when given', async () => {
    const submitted = await submittedApplication()
    const underReview = await advance(reviewer, submitted, 'under_review')

    const noReason = await reviewer.post(
      `${API}/applications/${underReview.id}/transitions`,
      { version: underReview.version, toStatus: 'rejected' },
    )
    expectError(noReason, 400, 'bad_request')

    // Still under review: the refused attempt changed nothing.
    const unchanged = await reviewer.get(`${API}/applications/${underReview.id}`)
    expect((unchanged.json() as ApplicationBody).status).toBe('under_review')

    const rejected = await reviewer.post(
      `${API}/applications/${underReview.id}/transitions`,
      {
        version: underReview.version,
        toStatus: 'rejected',
        note: 'নথিতে দাগ নম্বর মেলেনি।',
      },
    )
    expectStatus(rejected, 200)
    const settled = rejected.json() as ApplicationBody

    expect(settled.status).toBe('rejected')
    expect(settled.decidedAt).toEqual(expect.any(String))
    expect(settled.decisionNote).toBe('নথিতে দাগ নম্বর মেলেনি।')
  })

  it('treats a settled application as final', async () => {
    const submitted = await submittedApplication()
    const underReview = await advance(reviewer, submitted, 'under_review')
    const rejected = await advance(reviewer, underReview, {
      toStatus: 'rejected',
      note: 'নথি অসম্পূর্ণ।',
    })

    const response = await reviewer.post(
      `${API}/applications/${rejected.id}/transitions`,
      { version: rejected.version, toStatus: 'under_review' },
    )

    expectError(response, 409, 'invalid_transition')
  })

  it('carries a request for documents and a deadline, and lets the applicant respond', async () => {
    const submitted = await submittedApplication()
    const underReview = await advance(reviewer, submitted, 'under_review')

    const askedForDocuments = await reviewer.post(
      `${API}/applications/${underReview.id}/transitions`,
      {
        version: underReview.version,
        toStatus: 'documents_required',
        nextStep: 'সর্বশেষ খতিয়ানের কপি জমা দিন।',
        deadline: '2030-01-01',
      },
    )
    expectStatus(askedForDocuments, 200)
    const waiting = askedForDocuments.json() as ApplicationBody

    expect(waiting.status).toBe('documents_required')
    expect(waiting.nextStep).toContain('খতিয়ান')
    expect(waiting.deadline).toEqual(expect.any(String))

    // The applicant may hand the documents over, which puts it back under
    // review — the one review step an applicant drives.
    const responded = await applicant.post(
      `${API}/applications/${waiting.id}/transitions`,
      { version: waiting.version, toStatus: 'under_review' },
    )
    expectStatus(responded, 200)
    const back = responded.json() as ApplicationBody

    expect(back.status).toBe('under_review')
    // The request is cleared once it has been answered.
    expect(back.nextStep).toBeNull()
    expect(back.deadline).toBeNull()
  })

  it('refuses a stale version on a transition, even while the transition is still valid', async () => {
    const submitted = await submittedApplication()

    // Somebody corrects the filing first, so the version moves on while the
    // status stays `submitted`.
    expectStatus(
      await admin.patch(`${API}/applications/${submitted.id}`, {
        version: submitted.version,
        mouza: 'Corrected before the review began',
      }),
      200,
    )

    // The transition is still legal from `submitted`; it is the version that is
    // stale, and that is what the guard refuses.
    const stale = await reviewer.post(
      `${API}/applications/${submitted.id}/transitions`,
      { version: submitted.version, toStatus: 'under_review' },
    )

    expectError(stale, 409, 'concurrent_modification')
  })

  it('applies a transition only once when two requests race', async () => {
    const submitted = await submittedApplication()

    const body = { version: submitted.version, toStatus: 'under_review' }
    const [first, second] = await Promise.all([
      reviewer.post(`${API}/applications/${submitted.id}/transitions`, body),
      reviewer.post(`${API}/applications/${submitted.id}/transitions`, body),
    ])

    // Exactly one request moves it; the other is refused, whether by the state
    // guard or by the version guard.
    expect([first.statusCode, second.statusCode].sort()).toEqual([200, 409])

    const response = await reviewer.get(`${API}/applications/${submitted.id}`)
    expectStatus(response, 200)
    const after = response.json() as ApplicationBody

    expect(after.status).toBe('under_review')
    // Moved once, not twice: the version advanced by exactly one step.
    expect(after.version).toBe(submitted.version + 1)
  })

  it('reports somebody else’s filing as not found', async () => {
    const submitted = await submittedApplication()

    expectError(
      await otherApplicant.post(`${API}/applications/${submitted.id}/transitions`, {
        version: submitted.version,
        toStatus: 'under_review',
      }),
      404,
      'not_found',
    )
  })
})
