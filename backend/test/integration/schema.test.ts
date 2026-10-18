import { randomUUID } from 'node:crypto'
import { readdirSync } from 'node:fs'

import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { Database } from '../../src/db/client.js'
import { DEFAULT_MIGRATIONS_FOLDER } from '../../src/db/migrate.js'
import { auditEvents } from '../../src/db/schema/audit.js'
import { sourceDocuments } from '../../src/db/schema/documents.js'
import { extractions } from '../../src/db/schema/extractions.js'
import { parcelLineage } from '../../src/db/schema/lineage.js'
import { parcelDags, parcels } from '../../src/db/schema/parcels.js'
import { reviewDecisions } from '../../src/db/schema/reviews.js'
import { users } from '../../src/db/schema/users.js'
import {
  closeTestDatabase,
  expectRejection,
  firstOrThrow,
  initializeTestDatabase,
} from '../helpers/database.js'

/**
 * Unique per run so that the suite can be re-run against a long-lived test
 * database without cleaning up after itself. Append-only rows in particular
 * cannot be deleted, so fixtures must never collide.
 */
const RUN = randomUUID().replaceAll('-', '').slice(0, 10)

const EXPECTED_TABLES = [
  'audit_events',
  'extractions',
  'findings',
  'parcel_dags',
  'parcel_lineage',
  'parcels',
  'review_decisions',
  'source_documents',
  'users',
] as const

let database: Database

beforeAll(async () => {
  database = await initializeTestDatabase()
})

afterAll(async () => {
  await closeTestDatabase()
})

function syntheticParcelValues(
  khatianNumber: string,
): typeof parcels.$inferInsert {
  return {
    survey: 'BS',
    origin: 'synthetic_demo',
    district: `TestDistrict-${RUN}`,
    upazila: 'TestUpazila',
    mouza: 'TestMouza',
    jlNumber: '43',
    khatianNumber,
    areaDecimal: '125.0000',
    shareNumerator: 1,
    shareDenominator: 3,
  }
}

async function insertParcel(
  khatianNumber: string,
): Promise<typeof parcels.$inferSelect> {
  const rows = await database.orm
    .insert(parcels)
    .values(syntheticParcelValues(khatianNumber))
    .returning()
  return firstOrThrow(rows)
}

async function insertReviewer(): Promise<typeof users.$inferSelect> {
  const rows = await database.orm
    .insert(users)
    .values({
      email: `reviewer-${randomUUID()}@example.test`,
      passwordHash: 'not-a-real-hash',
      displayName: 'Synthetic Reviewer',
      role: 'reviewer',
    })
    .returning()
  return firstOrThrow(rows)
}

describe('migrations', () => {
  it('creates every domain table', async () => {
    const result = await database.pool.query<{ table_name: string }>(
      `select table_name from information_schema.tables
        where table_schema = 'public' order by table_name`,
    )

    const names = result.rows.map((row) => row.table_name)
    expect(names).toEqual(expect.arrayContaining([...EXPECTED_TABLES]))
  })

  it('installs the integrity triggers', async () => {
    const result = await database.pool.query<{ tgname: string }>(
      `select tgname from pg_trigger where not tgisinternal order by tgname`,
    )

    const names = result.rows.map((row) => row.tgname)
    expect(names).toEqual(
      expect.arrayContaining([
        'audit_events_append_only',
        'review_decisions_append_only',
        'parcels_touch_updated_at',
        'users_touch_updated_at',
      ]),
    )
  })

  it('applies each committed migration exactly once', async () => {
    const committedMigrations = readdirSync(DEFAULT_MIGRATIONS_FOLDER).filter(
      (entry) => entry.endsWith('.sql'),
    )
    const result = await database.pool.query<{ count: string }>(
      `select count(*)::text as count from drizzle.__drizzle_migrations`,
    )

    expect(committedMigrations.length).toBeGreaterThanOrEqual(3)
    expect(Number(result.rows[0]?.count)).toBe(committedMigrations.length)
  })
})

describe('parcels', () => {
  it('stores exact decimal areas and rational shares', async () => {
    const parcel = await insertParcel(`${RUN}-exact`)

    expect(parcel.areaDecimal).toBe('125.0000')
    expect(parcel.shareNumerator).toBe(1)
    expect(parcel.shareDenominator).toBe(3)
  })

  it('rejects a duplicate parcel identity', async () => {
    const khatianNumber = `${RUN}-duplicate`
    await insertParcel(khatianNumber)

    await expectRejection(
      () => insertParcel(khatianNumber),
      'parcels_identity_unique',
    )
  })

  it('rejects a non-positive share denominator', async () => {
    await expectRejection(
      () =>
        database.orm.insert(parcels).values({
          ...syntheticParcelValues(`${RUN}-denominator`),
          shareDenominator: 0,
        }),
      'parcels_share_denominator_positive',
    )
  })

  it('rejects a negative area', async () => {
    await expectRejection(
      () =>
        database.orm.insert(parcels).values({
          ...syntheticParcelValues(`${RUN}-negative`),
          areaDecimal: '-1',
        }),
      'parcels_area_non_negative',
    )
  })

  it('maintains updated_at in the database and leaves created_at alone', async () => {
    const created = await insertParcel(`${RUN}-timestamps`)

    await new Promise((resolve) => setTimeout(resolve, 25))

    const updatedRows = await database.orm
      .update(parcels)
      .set({ areaDecimal: '126.0000' })
      .where(eq(parcels.id, created.id))
      .returning()

    const updated = await firstOrThrow(updatedRows)

    expect(updated.areaDecimal).toBe('126.0000')
    expect(updated.updatedAt.getTime()).toBeGreaterThan(
      created.updatedAt.getTime(),
    )
    expect(updated.createdAt.getTime()).toBe(created.createdAt.getTime())
  })
})

describe('parcel dags and lineage', () => {
  it('cascades dag numbers when the parcel is deleted', async () => {
    const parcel = await insertParcel(`${RUN}-cascade`)
    await database.orm.insert(parcelDags).values([
      { parcelId: parcel.id, dagNumber: '900' },
      { parcelId: parcel.id, dagNumber: '901' },
    ])

    await database.orm.delete(parcels).where(eq(parcels.id, parcel.id))

    const remaining = await database.orm
      .select()
      .from(parcelDags)
      .where(eq(parcelDags.parcelId, parcel.id))
    expect(remaining).toHaveLength(0)
  })

  it('blocks deleting a parcel that still has lineage links', async () => {
    const from = await insertParcel(`${RUN}-restrict-from`)
    const to = await insertParcel(`${RUN}-restrict-to`)
    await database.orm.insert(parcelLineage).values({
      fromParcelId: from.id,
      toParcelId: to.id,
      relation: 'continued',
      certainty: 'confirmed',
    })

    await expectRejection(
      () => database.orm.delete(parcels).where(eq(parcels.id, from.id)),
      'parcel_lineage',
    )
  })

  it('rejects a self-referential lineage link', async () => {
    const parcel = await insertParcel(`${RUN}-self`)

    await expectRejection(
      () =>
        database.orm.insert(parcelLineage).values({
          fromParcelId: parcel.id,
          toParcelId: parcel.id,
          relation: 'split',
        }),
      'parcel_lineage_not_self_referential',
    )
  })
})

describe('extractions', () => {
  it('rejects a correction that carries no reviewed value', async () => {
    const parcel = await insertParcel(`${RUN}-correction`)

    await expectRejection(
      () =>
        database.orm.insert(extractions).values({
          parcelId: parcel.id,
          field: 'area',
          recordedValue: '125.0000',
          reviewStatus: 'corrected',
          reviewedValue: null,
        }),
      'extractions_reviewed_value_consistency',
    )
  })

  it('rejects a reviewed value on a record that was not corrected', async () => {
    const parcel = await insertParcel(`${RUN}-confirmed`)

    await expectRejection(
      () =>
        database.orm.insert(extractions).values({
          parcelId: parcel.id,
          field: 'area',
          recordedValue: '125.0000',
          reviewStatus: 'confirmed',
          reviewedValue: '126.0000',
        }),
      'extractions_reviewed_value_consistency',
    )
  })

  it('rejects a confidence outside the 0..1 range', async () => {
    const parcel = await insertParcel(`${RUN}-confidence`)

    await expectRejection(
      () =>
        database.orm.insert(extractions).values({
          parcelId: parcel.id,
          field: 'area',
          recordedValue: '125.0000',
          confidence: '1.500',
        }),
      'extractions_confidence_range',
    )
  })
})

describe('source documents', () => {
  it('accepts a well-formed SHA-256 checksum', async () => {
    const rows = await database.orm
      .insert(sourceDocuments)
      .values({
        title: 'Synthetic check',
        origin: 'synthetic_demo',
        checksumSha256: 'a'.repeat(64),
      })
      .returning()

    expect((await firstOrThrow(rows)).checksumSha256).toHaveLength(64)
  })

  it('rejects a malformed checksum', async () => {
    await expectRejection(
      () =>
        database.orm
          .insert(sourceDocuments)
          .values({
            title: 'Synthetic check',
            origin: 'synthetic_demo',
            checksumSha256: 'not-a-hash',
          }),
      'source_documents_checksum_shape',
    )
  })
})

describe('review decisions and the audit trail', () => {
  it('rejects a decision that concerns neither a finding nor an extraction', async () => {
    const reviewer = await insertReviewer()

    await expectRejection(
      () =>
        database.orm.insert(reviewDecisions).values({
          reviewerId: reviewer.id,
          outcome: 'verified',
        }),
      'review_decisions_target_present',
    )
  })

  it('preserves review history by appending rather than overwriting', async () => {
    const reviewer = await insertReviewer()
    const parcel = await insertParcel(`${RUN}-history`)
    const extractionRows = await database.orm
      .insert(extractions)
      .values({
        parcelId: parcel.id,
        field: 'area',
        recordedValue: '125.0000',
      })
      .returning()
    const extraction = await firstOrThrow(extractionRows)

    await database.orm.insert(reviewDecisions).values([
      {
        extractionId: extraction.id,
        reviewerId: reviewer.id,
        outcome: 'needs_review',
        note: 'প্রথম পর্যালোচনা',
      },
      {
        extractionId: extraction.id,
        reviewerId: reviewer.id,
        outcome: 'correction',
        proposedValue: '125.5000',
        note: 'সংশোধিত প্রস্তাব',
      },
    ])

    const decisions = await database.orm
      .select()
      .from(reviewDecisions)
      .where(eq(reviewDecisions.extractionId, extraction.id))

    expect(decisions).toHaveLength(2)
    expect(decisions.map((decision) => decision.outcome).sort()).toEqual([
      'correction',
      'needs_review',
    ])
  })

  it('refuses to update a review decision', async () => {
    const reviewer = await insertReviewer()
    const parcel = await insertParcel(`${RUN}-immutable-decision`)
    const extractionRows = await database.orm
      .insert(extractions)
      .values({ parcelId: parcel.id, field: 'area', recordedValue: '1' })
      .returning()
    const extraction = await firstOrThrow(extractionRows)
    const decisionRows = await database.orm
      .insert(reviewDecisions)
      .values({
        extractionId: extraction.id,
        reviewerId: reviewer.id,
        outcome: 'verified',
      })
      .returning()
    const decision = await firstOrThrow(decisionRows)

    await expectRejection(
      () =>
        database.orm.execute(
          sql`update review_decisions set outcome = 'needs_review' where id = ${decision.id}`,
        ),
      'append-only',
    )
  })

  it('refuses to delete a review decision', async () => {
    const reviewer = await insertReviewer()
    const parcel = await insertParcel(`${RUN}-undeletable-decision`)
    const extractionRows = await database.orm
      .insert(extractions)
      .values({ parcelId: parcel.id, field: 'area', recordedValue: '2' })
      .returning()
    const extraction = await firstOrThrow(extractionRows)
    const decisionRows = await database.orm
      .insert(reviewDecisions)
      .values({
        extractionId: extraction.id,
        reviewerId: reviewer.id,
        outcome: 'verified',
      })
      .returning()
    const decision = await firstOrThrow(decisionRows)

    await expectRejection(
      () =>
        database.orm.execute(
          sql`delete from review_decisions where id = ${decision.id}`,
        ),
      'append-only',
    )
  })

  it('refuses to update or delete audit events', async () => {
    const eventRows = await database.orm
      .insert(auditEvents)
      .values({
        action: 'test.event',
        entityType: 'test',
        entityId: RUN,
        summary: 'Synthetic audit event created by the integration suite.',
      })
      .returning()
    const event = await firstOrThrow(eventRows)

    await expectRejection(
      () =>
        database.orm.execute(
          sql`update audit_events set summary = 'tampered' where id = ${event.id}`,
        ),
      'append-only',
    )

    await expectRejection(
      () =>
        database.orm.execute(
          sql`delete from audit_events where id = ${event.id}`,
        ),
      'append-only',
    )
  })
})
