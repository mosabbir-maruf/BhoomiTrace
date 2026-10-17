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
 * The reviewer workflow.
 *
 * Three properties matter more than the rest:
 *
 * 1. `recordedValue` is never overwritten. A correction is added beside the
 *    original reading, and a confirmation leaves it exactly as read.
 * 2. A decision is appended, never edited. The history shows every decision
 *    taken, including ones later superseded.
 * 3. Only a reviewer decides. An applicant can follow what happened to their own
 *    filing but cannot move it along.
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

interface ExtractionBody {
  id: string
  parcelId: string
  recordedValue: string
  reviewedValue: string | null
  reviewStatus: string
  reviewedBy: string | null
  reviewedAt: string | null
  version: number
}

interface DecisionBody {
  id: string
  findingId: string | null
  extractionId: string | null
  reviewerId: string
  outcome: string
  extractedValue: string | null
  proposedValue: string | null
  note: string | null
  createdAt: string
}

interface FindingBody {
  id: string
  parcelId: string
  kind: string
  severity: string
  status: string
  title: string
  explanation: string
  ruleCode: string | null
  version: number
}

async function recordExtraction(
  client: TestClient,
  parcelId: string,
  field: string,
  value: string,
): Promise<ExtractionBody> {
  const response = await client.post(`${API}/parcels/${parcelId}/extractions`, {
    field,
    recordedValue: value,
  })
  expectStatus(response, 201)
  return response.json() as ExtractionBody
}

/** Resolves or dismisses through the API, returning the updated finding. */
async function viewFinding(findingId: string): Promise<FindingBody> {
  const response = await reviewer.get(`${API}/findings/${findingId}`)
  expectStatus(response, 200)
  return (response.json() as { finding: FindingBody }).finding
}

async function decisionsForFinding(findingId: string): Promise<DecisionBody[]> {
  const response = await reviewer.get(`${API}/findings/${findingId}/decisions`)
  expectStatus(response, 200)
  return (response.json() as { items: DecisionBody[] }).items
}

/**
 * A freshly created parcel with a non-numeric khatian and no lineage fails two
 * checks with a finding kind, so reconciliation raises findings reliably without
 * depending on seeded data.
 */
async function parcelWithFindings(): Promise<{
  parcelId: string
  findings: FindingBody[]
}> {
  const parcel = await createParcel(applicant)
  const response = await applicant.post(`${API}/parcels/${parcel.id}/reconciliation`)
  expectStatus(response, 200)

  const body = response.json() as { raisedFindings: { id: string }[] }
  expect(body.raisedFindings.length).toBeGreaterThan(0)

  const findings: FindingBody[] = []
  for (const raised of body.raisedFindings) {
    findings.push(await viewFinding(raised.id))
  }
  return { parcelId: parcel.id, findings }
}

/* -------------------------------------------------------------------------- */
/* Reviewer identity                                                           */
/* -------------------------------------------------------------------------- */

describe('who may decide', () => {
  it('refuses an applicant reviewing their own extraction', async () => {
    const parcel = await createParcel(applicant)
    const extraction = await recordExtraction(applicant, parcel.id, 'area', '10.0000')

    const response = await applicant.post(`${API}/extractions/${extraction.id}/review`, {
      outcome: 'verified',
      version: extraction.version,
    })

    expectError(response, 403, 'forbidden')
  })

  it('refuses an applicant reviewing somebody else’s extraction', async () => {
    const parcel = await createParcel(otherApplicant)
    const extraction = await recordExtraction(otherApplicant, parcel.id, 'area', '10.0000')

    const response = await applicant.post(`${API}/extractions/${extraction.id}/review`, {
      outcome: 'verified',
      version: extraction.version,
    })

    expectError(response, 403, 'forbidden')
  })

  it('refuses an applicant moving a finding forward', async () => {
    const { findings } = await parcelWithFindings()
    const finding = findings[0]

    if (finding === undefined) throw new Error('Expected a raised finding.')

    const response = await applicant.post(`${API}/findings/${finding.id}/review`, {
      action: 'resolved',
      reason: 'I would like this closed.',
      version: finding.version,
    })

    expectError(response, 403, 'forbidden')
  })

  it('lets an administrator decide, like a reviewer', async () => {
    const parcel = await createParcel(applicant)
    const extraction = await recordExtraction(applicant, parcel.id, 'area', '10.0000')

    const response = await admin.post(`${API}/extractions/${extraction.id}/review`, {
      outcome: 'verified',
      version: extraction.version,
    })

    expectStatus(response, 200)
  })
})

/* -------------------------------------------------------------------------- */
/* Extraction decisions                                                        */
/* -------------------------------------------------------------------------- */

describe('POST /extractions/:extractionId/review', () => {
  it('confirms a value without touching what was read', async () => {
    const parcel = await createParcel(applicant)
    const extraction = await recordExtraction(applicant, parcel.id, 'area', '120.5000')

    const response = await reviewer.post(`${API}/extractions/${extraction.id}/review`, {
      outcome: 'verified',
      note: 'Checked against the record.',
      version: extraction.version,
    })

    expectStatus(response, 200)
    const body = response.json() as { extraction: ExtractionBody; decision: DecisionBody }

    expect(body.extraction.reviewStatus).toBe('confirmed')
    // A confirmation is not a rewrite.
    expect(body.extraction.recordedValue).toBe('120.5000')
    expect(body.extraction.reviewedValue).toBeNull()
    expect(body.extraction.reviewedBy).toBe(reviewer.account.id)
    expect(body.extraction.reviewedAt).toEqual(expect.any(String))

    expect(body.decision.outcome).toBe('verified')
    expect(body.decision.extractedValue).toBe('120.5000')
    expect(body.decision.proposedValue).toBeNull()
    expect(body.decision.reviewerId).toBe(reviewer.account.id)
  })

  it('records a correction beside the original reading, never over it', async () => {
    const parcel = await createParcel(applicant)
    const extraction = await recordExtraction(applicant, parcel.id, 'area', '120.5000')

    const response = await reviewer.post(`${API}/extractions/${extraction.id}/review`, {
      outcome: 'correction',
      correctedValue: '125.0000',
      note: 'The record reads 125.',
      version: extraction.version,
    })

    expectStatus(response, 200)
    const body = response.json() as { extraction: ExtractionBody; decision: DecisionBody }

    expect(body.extraction.reviewStatus).toBe('corrected')
    // Both values are present and distinct; the reading survives.
    expect(body.extraction.recordedValue).toBe('120.5000')
    expect(body.extraction.reviewedValue).toBe('125.0000')

    expect(body.decision.outcome).toBe('correction')
    expect(body.decision.extractedValue).toBe('120.5000')
    expect(body.decision.proposedValue).toBe('125.0000')
  })

  it('refuses a correction identical to the recorded value', async () => {
    const parcel = await createParcel(applicant)
    const extraction = await recordExtraction(applicant, parcel.id, 'area', '120.5000')

    const response = await reviewer.post(`${API}/extractions/${extraction.id}/review`, {
      outcome: 'correction',
      correctedValue: ' 120.5000 ',
      version: extraction.version,
    })

    // Recording a change that did not happen would misstate the history.
    expectError(response, 400, 'bad_request')
  })

  it('refuses a replacement value attached to a confirmation', async () => {
    const parcel = await createParcel(applicant)
    const extraction = await recordExtraction(applicant, parcel.id, 'area', '120.5000')

    const response = await reviewer.post(`${API}/extractions/${extraction.id}/review`, {
      outcome: 'verified',
      correctedValue: '125.0000',
      version: extraction.version,
    })

    expectError(response, 400, 'bad_request')
  })

  it('requires a note when marking a value as needing review', async () => {
    const parcel = await createParcel(applicant)
    const extraction = await recordExtraction(applicant, parcel.id, 'share', '১/২ (অস্পষ্ট)')

    const withoutNote = await reviewer.post(
      `${API}/extractions/${extraction.id}/review`,
      { outcome: 'needs_review', version: extraction.version },
    )
    expectError(withoutNote, 400, 'bad_request')

    const withNote = await reviewer.post(`${API}/extractions/${extraction.id}/review`, {
      outcome: 'needs_review',
      note: 'The share column is smudged; it needs the original register.',
      version: extraction.version,
    })
    expectStatus(withNote, 200)

    const body = withNote.json() as { extraction: ExtractionBody; decision: DecisionBody }
    expect(body.extraction.reviewStatus).toBe('unclear')
    expect(body.decision.outcome).toBe('needs_review')
    expect(body.decision.note).toBe(
      'The share column is smudged; it needs the original register.',
    )
  })

  it('refuses a stale version rather than overwriting another reviewer', async () => {
    const parcel = await createParcel(applicant)
    const extraction = await recordExtraction(applicant, parcel.id, 'area', '120.5000')

    expectStatus(
      await reviewer.post(`${API}/extractions/${extraction.id}/review`, {
        outcome: 'verified',
        version: extraction.version,
      }),
      200,
    )

    const stale = await reviewer.post(`${API}/extractions/${extraction.id}/review`, {
      outcome: 'correction',
      correctedValue: '1.0000',
      version: extraction.version,
    })

    expectError(stale, 409, 'concurrent_modification')
  })

  it('reports an unknown extraction as not found', async () => {
    const response = await reviewer.post(`${API}/extractions/${unknownUuid()}/review`, {
      outcome: 'verified',
      version: 1,
    })

    expectError(response, 404, 'not_found')
  })

  it('requires authentication and a CSRF token', async () => {
    const parcel = await createParcel(applicant)
    const extraction = await recordExtraction(applicant, parcel.id, 'area', '120.5000')

    const anonymous = await api.app.inject({
      method: 'POST',
      url: `${API}/extractions/${extraction.id}/review`,
      headers: { 'content-type': 'application/json' },
      payload: { outcome: 'verified', version: extraction.version },
    })
    expectError(anonymous, 401, 'unauthenticated')

    const noCsrf = await reviewer.post(
      `${API}/extractions/${extraction.id}/review`,
      { outcome: 'verified', version: extraction.version },
      { withCsrf: false },
    )
    expectError(noCsrf, 403, 'forbidden')
  })
})

/* -------------------------------------------------------------------------- */
/* Decision history                                                            */
/* -------------------------------------------------------------------------- */

describe('GET /extractions/:extractionId/decisions', () => {
  it('appends every decision, including a superseded one', async () => {
    const parcel = await createParcel(applicant)
    const extraction = await recordExtraction(applicant, parcel.id, 'area', '120.5000')

    const first = await reviewer.post(`${API}/extractions/${extraction.id}/review`, {
      outcome: 'correction',
      correctedValue: '125.0000',
      note: 'First look.',
      version: extraction.version,
    })
    expectStatus(first, 200)
    const afterFirst = (first.json() as { extraction: ExtractionBody }).extraction

    const second = await reviewer.post(`${API}/extractions/${extraction.id}/review`, {
      outcome: 'verified',
      note: 'Took a second look and accepted the reading.',
      version: afterFirst.version,
    })
    expectStatus(second, 200)

    const response = await reviewer.get(`${API}/extractions/${extraction.id}/decisions`)
    expectStatus(response, 200)

    const items = (response.json() as { items: DecisionBody[] }).items
    expect(items).toHaveLength(2)
    // Oldest first, and the superseded correction is still there.
    expect(items[0]?.outcome).toBe('correction')
    expect(items[0]?.proposedValue).toBe('125.0000')
    expect(items[1]?.outcome).toBe('verified')
    expect(items[1]?.extractedValue).toBe('120.5000')
  })

  it('lets the owner of the parcel follow the history', async () => {
    const parcel = await createParcel(applicant)
    const extraction = await recordExtraction(applicant, parcel.id, 'area', '120.5000')
    expectStatus(
      await reviewer.post(`${API}/extractions/${extraction.id}/review`, {
        outcome: 'verified',
        version: extraction.version,
      }),
      200,
    )

    const response = await applicant.get(`${API}/extractions/${extraction.id}/decisions`)

    expectStatus(response, 200)
    expect((response.json() as { items: DecisionBody[] }).items).toHaveLength(1)
  })

  it('reports the history of somebody else’s extraction as not found', async () => {
    const parcel = await createParcel(otherApplicant)
    const extraction = await recordExtraction(otherApplicant, parcel.id, 'area', '1.0000')

    const response = await applicant.get(`${API}/extractions/${extraction.id}/decisions`)

    expectError(response, 404, 'not_found')
  })
})

/* -------------------------------------------------------------------------- */
/* Findings                                                                    */
/* -------------------------------------------------------------------------- */

describe('findings lifecycle', () => {
  it('raises findings as discrepancies with rules named, not verdicts', async () => {
    const { parcelId, findings } = await parcelWithFindings()

    expect(findings.length).toBeGreaterThan(0)
    for (const finding of findings) {
      expect(finding.parcelId).toBe(parcelId)
      expect(finding.status).toBe('open')
      expect(finding.ruleCode).toEqual(expect.any(String))
      expect(finding.explanation.length).toBeGreaterThan(0)
      // The vocabulary is a discrepancy, never an accusation or a decision.
      const text = `${finding.title} ${finding.explanation}`.toLowerCase()
      expect(text).not.toContain('fraud')
      expect(text).not.toContain('guilty')
      expect(text).not.toContain('approved')
    }
  })

  it('does not raise a second finding for a rule that is already open', async () => {
    const parcel = await createParcel(applicant)

    const first = await applicant.post(`${API}/parcels/${parcel.id}/reconciliation`)
    expectStatus(first, 200)
    const firstBody = first.json() as { raisedFindings: { ruleCode: string }[] }
    expect(firstBody.raisedFindings.length).toBeGreaterThan(0)

    const second = await applicant.post(`${API}/parcels/${parcel.id}/reconciliation`)
    expectStatus(second, 200)
    const secondBody = second.json() as {
      raisedFindings: unknown[]
      existingOpenRules: string[]
    }

    expect(secondBody.raisedFindings).toEqual([])
    expect(secondBody.existingOpenRules).toEqual(
      expect.arrayContaining(firstBody.raisedFindings.map((item) => item.ruleCode)),
    )
  })

  it('moves a finding under review and then resolves it with a reason', async () => {
    const { findings } = await parcelWithFindings()
    const finding = findings[0]
    if (finding === undefined) throw new Error('Expected a raised finding.')

    const started = await reviewer.post(`${API}/findings/${finding.id}/review`, {
      action: 'under_review',
      version: finding.version,
    })
    expectStatus(started, 200)
    const underReview = started.json() as { finding: FindingBody; decision: DecisionBody }
    expect(underReview.finding.status).toBe('under_review')
    // `under_review` requires no reason: nothing is being settled.
    expect(underReview.decision.note).toBeNull()

    const resolved = await reviewer.post(`${API}/findings/${finding.id}/review`, {
      action: 'resolved',
      reason: 'Compared against the register; the record stands.',
      version: underReview.finding.version,
    })
    expectStatus(resolved, 200)

    const body = resolved.json() as { finding: FindingBody; decision: DecisionBody }
    expect(body.finding.status).toBe('resolved')
    expect(body.decision.outcome).toBe('verified')
    expect(body.decision.note).toBe('Compared against the register; the record stands.')
    // The decision points at the finding, not at an extraction.
    expect(body.decision.findingId).toBe(finding.id)
    expect(body.decision.extractionId).toBeNull()
  })

  it('requires a reason to resolve or dismiss', async () => {
    const { findings } = await parcelWithFindings()
    const finding = findings[0]
    if (finding === undefined) throw new Error('Expected a raised finding.')

    const response = await reviewer.post(`${API}/findings/${finding.id}/review`, {
      action: 'dismissed',
      version: finding.version,
    })

    // A finding that vanishes without a reason is indistinguishable from one
    // that was made to vanish.
    expectError(response, 400, 'bad_request')
  })

  it('refuses to settle a finding twice', async () => {
    const { findings } = await parcelWithFindings()
    const finding = findings[0]
    if (finding === undefined) throw new Error('Expected a raised finding.')

    const settled = await reviewer.post(`${API}/findings/${finding.id}/review`, {
      action: 'dismissed',
      reason: 'Superseded by the corrected record.',
      version: finding.version,
    })
    expectStatus(settled, 200)
    const afterSettle = (settled.json() as { finding: FindingBody }).finding

    const again = await reviewer.post(`${API}/findings/${finding.id}/review`, {
      action: 'resolved',
      reason: 'Resolved as well.',
      version: afterSettle.version,
    })

    expectError(again, 409, 'conflict')

    // One finding, one decision: the history stays unambiguous.
    expect(await decisionsForFinding(finding.id)).toHaveLength(1)
  })

  it('refuses to place a settled finding under review', async () => {
    const { findings } = await parcelWithFindings()
    const finding = findings[0]
    if (finding === undefined) throw new Error('Expected a raised finding.')

    const settled = await reviewer.post(`${API}/findings/${finding.id}/review`, {
      action: 'resolved',
      reason: 'Dealt with.',
      version: finding.version,
    })
    expectStatus(settled, 200)
    const afterSettle = (settled.json() as { finding: FindingBody }).finding

    const response = await reviewer.post(`${API}/findings/${finding.id}/review`, {
      action: 'under_review',
      version: afterSettle.version,
    })

    expectError(response, 409, 'conflict')
  })

  it('refuses a stale version rather than overwriting', async () => {
    const { findings } = await parcelWithFindings()
    const finding = findings[0]
    if (finding === undefined) throw new Error('Expected a raised finding.')

    expectStatus(
      await reviewer.post(`${API}/findings/${finding.id}/review`, {
        action: 'under_review',
        version: finding.version,
      }),
      200,
    )

    const stale = await reviewer.post(`${API}/findings/${finding.id}/review`, {
      action: 'resolved',
      reason: 'Resolved from a stale copy.',
      version: finding.version,
    })

    expectError(stale, 409, 'concurrent_modification')
  })

  it('raises the concern again after it was settled, as a new finding', async () => {
    const parcel = await createParcel(applicant)

    const raised = await applicant.post(`${API}/parcels/${parcel.id}/reconciliation`)
    expectStatus(raised, 200)
    const raisedBody = raised.json() as {
      raisedFindings: { id: string; ruleCode: string }[]
    }
    const target = raisedBody.raisedFindings[0]
    if (target === undefined) throw new Error('Expected a raised finding.')

    const current = await viewFinding(target.id)
    const settled = await reviewer.post(`${API}/findings/${target.id}/review`, {
      action: 'resolved',
      reason: 'Reviewed and closed.',
      version: current.version,
    })
    expectStatus(settled, 200)

    // The condition still holds, so a new finding appears — separate from the
    // settled one, whose decision stays readable.
    const again = await applicant.post(`${API}/parcels/${parcel.id}/reconciliation`)
    expectStatus(again, 200)
    const againBody = again.json() as {
      raisedFindings: { id: string; ruleCode: string }[]
      existingOpenRules: string[]
    }

    const reRaised = againBody.raisedFindings.find(
      (item) => item.ruleCode === target.ruleCode,
    )
    expect(reRaised).toBeDefined()
    expect(reRaised?.id).not.toBe(target.id)

    const settledAgain = await viewFinding(target.id)
    expect(settledAgain.status).toBe('resolved')
  })

  it('reports somebody else’s finding as not found to an applicant', async () => {
    const parcel = await createParcel(otherApplicant)
    const raised = await otherApplicant.post(
      `${API}/parcels/${parcel.id}/reconciliation`,
    )
    expectStatus(raised, 200)
    const finding = (raised.json() as { raisedFindings: { id: string }[] })
      .raisedFindings[0]
    if (finding === undefined) throw new Error('Expected a raised finding.')

    const response = await applicant.get(`${API}/findings/${finding.id}`)

    expectError(response, 404, 'not_found')
  })
})

/* -------------------------------------------------------------------------- */
/* Review queue                                                                */
/* -------------------------------------------------------------------------- */

describe('GET /review/queue', () => {
  it('refuses an applicant the queue', async () => {
    const response = await applicant.get(`${API}/review/queue`)

    expectError(response, 403, 'forbidden')
  })

  it('shows a reviewer outstanding work with totals', async () => {
    const parcel = await createParcel(applicant)
    await recordExtraction(applicant, parcel.id, 'area', '120.5000')
    const raised = await applicant.post(`${API}/parcels/${parcel.id}/reconciliation`)
    expectStatus(raised, 200)

    const response = await reviewer.get(
      `${API}/review/queue?limit=50&parcelId=${parcel.id}`,
    )

    expectStatus(response, 200)
    const queue = response.json() as {
      pendingExtractions: ExtractionBody[]
      openFindings: FindingBody[]
      totals: { pendingExtractions: number; openFindings: number }
    }

    expect(queue.pendingExtractions.map((item) => item.parcelId)).toEqual([parcel.id])
    expect(queue.openFindings.length).toBeGreaterThan(0)
    expect(queue.totals.pendingExtractions).toBeGreaterThanOrEqual(1)
    expect(queue.totals.openFindings).toBeGreaterThanOrEqual(1)
  })

  it('drops a value from the queue once it has been decided', async () => {
    const parcel = await createParcel(applicant)
    const extraction = await recordExtraction(applicant, parcel.id, 'area', '120.5000')

    const before = await reviewer.get(`${API}/review/queue?limit=50&parcelId=${parcel.id}`)
    expectStatus(before, 200)
    expect(
      (before.json() as { pendingExtractions: ExtractionBody[] }).pendingExtractions.map(
        (item) => item.id,
      ),
    ).toContain(extraction.id)

    expectStatus(
      await reviewer.post(`${API}/extractions/${extraction.id}/review`, {
        outcome: 'verified',
        version: extraction.version,
      }),
      200,
    )

    const after = await reviewer.get(`${API}/review/queue?limit=50&parcelId=${parcel.id}`)
    expectStatus(after, 200)
    expect(
      (after.json() as { pendingExtractions: ExtractionBody[] }).pendingExtractions.map(
        (item) => item.id,
      ),
    ).not.toContain(extraction.id)
  })

  it('can filter the finding side by severity', async () => {
    const { parcelId, findings } = await parcelWithFindings()
    const severities = new Set(findings.map((finding) => finding.severity))
    const severity = [...severities][0]
    if (severity === undefined) throw new Error('Expected at least one severity.')

    const response = await reviewer.get(
      `${API}/review/queue?limit=50&parcelId=${parcelId}&severity=${severity}`,
    )

    expectStatus(response, 200)
    const queue = response.json() as { openFindings: FindingBody[] }
    expect(queue.openFindings.length).toBeGreaterThan(0)
    for (const finding of queue.openFindings) {
      expect(finding.severity).toBe(severity)
    }
  })
})
