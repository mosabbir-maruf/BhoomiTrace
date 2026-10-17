import { randomUUID } from 'node:crypto'

import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { Database } from '../../src/db/client.js'
import { auditEvents } from '../../src/db/schema/audit.js'
import { sourceDocuments } from '../../src/db/schema/documents.js'
import { extractions } from '../../src/db/schema/extractions.js'
import { findings } from '../../src/db/schema/findings.js'
import { parcels } from '../../src/db/schema/parcels.js'
import { reviewDecisions } from '../../src/db/schema/reviews.js'
import { users } from '../../src/db/schema/users.js'
import {
  closeTestDatabase,
  expectRejection,
  firstOrThrow,
  initializeTestDatabase,
} from '../helpers/database.js'

/**
 * Demonstrates the documented deletion policy: referential actions must never
 * contradict the append-only triggers on `review_decisions` and `audit_events`.
 *
 * Each test uses freshly generated identifiers, so the suite is repeatable
 * against a long-lived test database even though append-only rows can never be
 * removed.
 */
const RUN = randomUUID().replaceAll('-', '').slice(0, 10)

let database: Database

beforeAll(async () => {
  database = await initializeTestDatabase()
})

afterAll(async () => {
  await closeTestDatabase()
})

async function insertUser(): Promise<typeof users.$inferSelect> {
  const rows = await database.orm
    .insert(users)
    .values({
      email: `policy-${randomUUID()}@example.test`,
      passwordHash: 'not-a-real-hash',
      displayName: 'Synthetic Account',
      role: 'reviewer',
    })
    .returning()
  return firstOrThrow(rows)
}

async function insertParcel(): Promise<typeof parcels.$inferSelect> {
  const rows = await database.orm
    .insert(parcels)
    .values({
      survey: 'RS',
      district: `PolicyDistrict-${RUN}`,
      upazila: 'PolicyUpazila',
      mouza: 'PolicyMouza',
      jlNumber: '43',
      khatianNumber: `policy-${randomUUID()}`,
      areaDecimal: '125.0000',
      shareNumerator: 1,
      shareDenominator: 2,
    })
    .returning()
  return firstOrThrow(rows)
}

async function insertExtraction(
  parcelId: string,
): Promise<typeof extractions.$inferSelect> {
  const rows = await database.orm
    .insert(extractions)
    .values({ parcelId, field: 'area', recordedValue: '125.0000' })
    .returning()
  return firstOrThrow(rows)
}

async function insertFinding(
  parcelId: string,
): Promise<typeof findings.$inferSelect> {
  const rows = await database.orm
    .insert(findings)
    .values({
      parcelId,
      kind: 'area_mismatch',
      severity: 'medium',
      title: 'Synthetic policy finding',
      explanation: 'Synthetic explanation used by the deletion-policy tests.',
    })
    .returning()
  return firstOrThrow(rows)
}

async function insertDecision(
  reviewerId: string,
  subject: { findingId?: string; extractionId?: string },
): Promise<typeof reviewDecisions.$inferSelect> {
  const rows = await database.orm
    .insert(reviewDecisions)
    .values({
      reviewerId,
      outcome: 'verified',
      ...(subject.findingId === undefined
        ? {}
        : { findingId: subject.findingId }),
      ...(subject.extractionId === undefined
        ? {}
        : { extractionId: subject.extractionId }),
    })
    .returning()
  return firstOrThrow(rows)
}

describe('referenced records cannot be deleted', () => {
  it('blocks deleting a finding that a review decision depends on', async () => {
    const reviewer = await insertUser()
    const parcel = await insertParcel()
    const finding = await insertFinding(parcel.id)
    await insertDecision(reviewer.id, { findingId: finding.id })

    await expectRejection(
      () => database.orm.delete(findings).where(eq(findings.id, finding.id)),
      'review_decisions_finding_id_findings_id_fk',
    )

    const survivors = await database.orm
      .select()
      .from(findings)
      .where(eq(findings.id, finding.id))
    expect(survivors).toHaveLength(1)
  })

  it('blocks deleting an extraction that a review decision depends on', async () => {
    const reviewer = await insertUser()
    const parcel = await insertParcel()
    const extraction = await insertExtraction(parcel.id)
    await insertDecision(reviewer.id, { extractionId: extraction.id })

    await expectRejection(
      () =>
        database.orm.delete(extractions).where(eq(extractions.id, extraction.id)),
      'review_decisions_extraction_id_extractions_id_fk',
    )
  })

  it('blocks deleting the reviewer of a review decision', async () => {
    const reviewer = await insertUser()
    const parcel = await insertParcel()
    const extraction = await insertExtraction(parcel.id)
    const decision = await insertDecision(reviewer.id, {
      extractionId: extraction.id,
    })

    await expectRejection(
      () => database.orm.delete(users).where(eq(users.id, reviewer.id)),
      'review_decisions_reviewer_id_users_id_fk',
    )

    // The decision is untouched, not rewritten.
    const after = await database.orm
      .select()
      .from(reviewDecisions)
      .where(eq(reviewDecisions.id, decision.id))
    expect(after[0]?.reviewerId).toBe(reviewer.id)
    expect(after[0]?.outcome).toBe('verified')
  })

  it('blocks deleting the actor of an audit event without nulling the reference', async () => {
    const actor = await insertUser()
    const eventRows = await database.orm
      .insert(auditEvents)
      .values({
        actorId: actor.id,
        action: 'policy.test',
        entityType: 'test',
        entityId: RUN,
      })
      .returning()
    const event = await firstOrThrow(eventRows)

    await expectRejection(
      () => database.orm.delete(users).where(eq(users.id, actor.id)),
      'audit_events_actor_id_users_id_fk',
    )

    const after = await database.orm
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.id, event.id))
    expect(after[0]?.actorId).toBe(actor.id)
  })

  it('blocks deleting a parcel while review history exists, leaving the whole graph intact', async () => {
    const reviewer = await insertUser()
    const parcel = await insertParcel()
    const extraction = await insertExtraction(parcel.id)
    const finding = await insertFinding(parcel.id)
    await insertDecision(reviewer.id, {
      extractionId: extraction.id,
      findingId: finding.id,
    })

    await expectRejection(
      () => database.orm.delete(parcels).where(eq(parcels.id, parcel.id)),
      'foreign key constraint',
    )

    // The delete is atomic: nothing was partially removed.
    const parcelSurvivors = await database.orm
      .select()
      .from(parcels)
      .where(eq(parcels.id, parcel.id))
    const extractionSurvivors = await database.orm
      .select()
      .from(extractions)
      .where(eq(extractions.id, extraction.id))
    const findingSurvivors = await database.orm
      .select()
      .from(findings)
      .where(eq(findings.id, finding.id))

    expect(parcelSurvivors).toHaveLength(1)
    expect(extractionSurvivors).toHaveLength(1)
    expect(findingSurvivors).toHaveLength(1)
  })
})

describe('unreferenced records can still be deleted', () => {
  it('deletes a finding that no review decision depends on', async () => {
    const parcel = await insertParcel()
    const finding = await insertFinding(parcel.id)

    await database.orm.delete(findings).where(eq(findings.id, finding.id))

    const remaining = await database.orm
      .select()
      .from(findings)
      .where(eq(findings.id, finding.id))
    expect(remaining).toHaveLength(0)
  })

  it('deletes an extraction that no review decision depends on', async () => {
    const parcel = await insertParcel()
    const extraction = await insertExtraction(parcel.id)

    await database.orm
      .delete(extractions)
      .where(eq(extractions.id, extraction.id))

    const remaining = await database.orm
      .select()
      .from(extractions)
      .where(eq(extractions.id, extraction.id))
    expect(remaining).toHaveLength(0)
  })

  it('deletes a user with no review history, nulling non-append-only references', async () => {
    const author = await insertUser()
    const documentRows = await database.orm
      .insert(sourceDocuments)
      .values({ title: 'Synthetic document', createdBy: author.id })
      .returning()
    const document = await firstOrThrow(documentRows)

    await database.orm.delete(users).where(eq(users.id, author.id))

    const remaining = await database.orm
      .select()
      .from(users)
      .where(eq(users.id, author.id))
    expect(remaining).toHaveLength(0)

    const documentAfter = await database.orm
      .select()
      .from(sourceDocuments)
      .where(eq(sourceDocuments.id, document.id))
    expect(documentAfter[0]?.createdBy).toBeNull()
  })

  it('cascades derived rows when a parcel has no review history', async () => {
    const parcel = await insertParcel()
    const extraction = await insertExtraction(parcel.id)
    const finding = await insertFinding(parcel.id)

    await database.orm.delete(parcels).where(eq(parcels.id, parcel.id))

    const extractionRemaining = await database.orm
      .select()
      .from(extractions)
      .where(eq(extractions.id, extraction.id))
    const findingRemaining = await database.orm
      .select()
      .from(findings)
      .where(eq(findings.id, finding.id))

    expect(extractionRemaining).toHaveLength(0)
    expect(findingRemaining).toHaveLength(0)
  })
})
