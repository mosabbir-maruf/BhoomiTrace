import { randomUUID } from 'node:crypto'
import { readdirSync } from 'node:fs'

import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { Database } from '../../src/db/client.js'
import { DEFAULT_MIGRATIONS_FOLDER } from '../../src/db/migrate.js'
import { authSessions } from '../../src/db/schema/sessions.js'
import { sourceDocuments } from '../../src/db/schema/documents.js'
import { extractions } from '../../src/db/schema/extractions.js'
import { findings } from '../../src/db/schema/findings.js'
import { processingJobs } from '../../src/db/schema/jobs.js'
import { documentPages } from '../../src/db/schema/pages.js'
import { parcels } from '../../src/db/schema/parcels.js'
import {
  readinessChecklistItems,
  readinessReports,
} from '../../src/db/schema/readiness.js'
import { users } from '../../src/db/schema/users.js'
import {
  closeTestDatabase,
  expectRejection,
  firstOrThrow,
  initializeTestDatabase,
} from '../helpers/database.js'

/**
 * The Phase 2 schema, tested where the application cannot hide a mistake.
 *
 * These assertions go straight to the database. They exist because the
 * invariants they check — one session per token hash, one page per number, one
 * job per idempotency key, a version that actually advances — are the kind that
 * an application can appear to honour while the schema does not enforce it, and
 * the difference only shows up under concurrency or after a bug.
 *
 * Nothing here is deleted to make a run repeatable. Every fixture carries a
 * per-run token, because append-only history accumulates by design.
 */

const RUN = randomUUID().replaceAll('-', '').slice(0, 10)

let database: Database

beforeAll(async () => {
  database = await initializeTestDatabase()
})

afterAll(async () => {
  await closeTestDatabase()
})

function newParcelValues(overrides: Partial<typeof parcels.$inferInsert> = {}): typeof parcels.$inferInsert {
  return {
    survey: 'BS',
    origin: 'user_created',
    district: `P2District-${RUN}`,
    upazila: 'P2Upazila',
    mouza: `P2Mouza-${RUN}`,
    jlNumber: `JL-${RUN}`,
    khatianNumber: `KH-${RUN}-${randomUUID().slice(0, 6)}`,
    areaDecimal: '125.0000',
    shareNumerator: 1,
    shareDenominator: 2,
    ...overrides,
  }
}

async function insertParcel(
  overrides: Partial<typeof parcels.$inferInsert> = {},
): Promise<typeof parcels.$inferSelect> {
  const rows = await database.orm
    .insert(parcels)
    .values(newParcelValues(overrides))
    .returning()
  return firstOrThrow(rows)
}

async function insertUser(
  role: 'applicant' | 'reviewer' | 'admin' = 'applicant',
): Promise<typeof users.$inferSelect> {
  const rows = await database.orm
    .insert(users)
    .values({
      email: `p2-${role}-${randomUUID()}@example.test`,
      passwordHash: 'not-a-real-hash',
      displayName: `Phase 2 ${role}`,
      role,
    })
    .returning()
  return firstOrThrow(rows)
}

async function insertDocument(
  ownerId: string | null = null,
): Promise<typeof sourceDocuments.$inferSelect> {
  const rows = await database.orm
    .insert(sourceDocuments)
    .values({
      ownerId,
      origin: ownerId === null ? 'synthetic_demo' : 'user_created',
      title: `Phase 2 document ${RUN}`,
      kind: 'manual_entry',
    })
    .returning()
  return firstOrThrow(rows)
}

describe('migrations', () => {
  it('creates the Phase 2 operational tables', async () => {
    const result = await database.pool.query<{ table_name: string }>(
      `select table_name from information_schema.tables
        where table_schema = 'public' order by table_name`,
    )

    expect(result.rows.map((row) => row.table_name)).toEqual(
      expect.arrayContaining([
        'auth_sessions',
        'document_pages',
        'processing_jobs',
        'readiness_checklist_items',
        'readiness_reports',
      ]),
    )
  })

  it('installs a version trigger on every versioned table', async () => {
    const result = await database.pool.query<{ tgname: string; tgrelid: string }>(
      `select tgname, tgrelid::regclass::text as tgrelid from pg_trigger
        where not tgisinternal order by tgname`,
    )

    const names = result.rows.map((row) => row.tgname)
    expect(names).toEqual(
      expect.arrayContaining([
        'parcels_bump_version',
        'source_documents_bump_version',
        'extractions_bump_version',
        'findings_bump_version',
      ]),
    )
  })

  it('has applied every committed migration exactly once', async () => {
    const committed = readdirSync(DEFAULT_MIGRATIONS_FOLDER).filter((entry) =>
      entry.endsWith('.sql'),
    )
    const result = await database.pool.query<{ count: string }>(
      `select count(*)::text as count from drizzle.__drizzle_migrations`,
    )

    expect(Number(result.rows[0]?.count)).toBe(committed.length)
  })
})

describe('auth_sessions', () => {
  it('stores only hashes: a duplicate token hash is refused by the database', async () => {
    const user = await insertUser()
    const tokenHash = `hash-${randomUUID()}`

    await database.orm.insert(authSessions).values({
      userId: user.id,
      tokenHash,
      csrfTokenHash: `csrf-${randomUUID()}`,
      expiresAt: new Date(Date.now() + 60_000),
    })

    // Two sessions may not share a lookup key; which one a request belonged to
    // would otherwise be arbitrary.
    await expectRejection(
      () => database.orm.insert(authSessions).values({
        userId: user.id,
        tokenHash,
        csrfTokenHash: `csrf-${randomUUID()}`,
        expiresAt: new Date(Date.now() + 60_000),
      }),
    )
  })

  it('treats sessions as operational rows: deleting the account removes them', async () => {
    const user = await insertUser()
    const session = await firstOrThrow(
      await database.orm
        .insert(authSessions)
        .values({
          userId: user.id,
          tokenHash: `hash-${randomUUID()}`,
          csrfTokenHash: `csrf-${randomUUID()}`,
          expiresAt: new Date(Date.now() + 60_000),
        })
        .returning(),
    )

    await database.orm.delete(users).where(eq(users.id, user.id))

    const remaining = await database.orm
      .select()
      .from(authSessions)
      .where(eq(authSessions.id, session.id))
    expect(remaining).toEqual([])
  })
})

describe('document_pages', () => {
  it('allows one row per document page number', async () => {
    const document = await insertDocument()

    await database.orm.insert(documentPages).values({
      sourceDocumentId: document.id,
      pageNumber: 1,
      label: 'প্রথম পাতা',
    })

    await expectRejection(
      () => database.orm.insert(documentPages).values({
        sourceDocumentId: document.id,
        pageNumber: 1,
      }),
    )
  })

  it('rejects a page number below one and a non-positive dimension', async () => {
    const document = await insertDocument()

    await expectRejection(
      () => database.orm.insert(documentPages).values({
        sourceDocumentId: document.id,
        pageNumber: 0,
      }),
    )

    await expectRejection(
      () => database.orm.insert(documentPages).values({
        sourceDocumentId: document.id,
        pageNumber: 2,
        width: 0,
      }),
    )
  })

  it('removes pages with the document they belong to', async () => {
    const document = await insertDocument()
    const page = await firstOrThrow(
      await database.orm
        .insert(documentPages)
        .values({ sourceDocumentId: document.id, pageNumber: 1 })
        .returning(),
    )

    await database.orm.delete(sourceDocuments).where(eq(sourceDocuments.id, document.id))

    const remaining = await database.orm
      .select()
      .from(documentPages)
      .where(eq(documentPages.id, page.id))
    expect(remaining).toEqual([])
  })
})

describe('processing_jobs', () => {
  it('is unique only among the keys that exist', async () => {
    const parcel = await insertParcel()

    // Job rows with no key are unaffected by the partial index.
    await database.orm.insert(processingJobs).values({
      kind: 'parcel_reconciliation',
      parcelId: parcel.id,
    })
    await database.orm.insert(processingJobs).values({
      kind: 'parcel_reconciliation',
      parcelId: parcel.id,
    })

    const key = `job-key-${RUN}-${randomUUID()}`
    await database.orm.insert(processingJobs).values({
      kind: 'parcel_reconciliation',
      parcelId: parcel.id,
      idempotencyKey: key,
    })

    await expectRejection(
      () => database.orm.insert(processingJobs).values({
        kind: 'parcel_reconciliation',
        parcelId: parcel.id,
        idempotencyKey: key,
      }),
    )
  })

  it('starts queued with a bounded attempt budget', async () => {
    const parcel = await insertParcel()
    const job = await firstOrThrow(
      await database.orm
        .insert(processingJobs)
        .values({ kind: 'parcel_reconciliation', parcelId: parcel.id })
        .returning(),
    )

    expect(job.status).toBe('queued')
    expect(job.attemptCount).toBe(0)
    expect(job.maxAttempts).toBeGreaterThanOrEqual(1)

    await expectRejection(
      () => database.orm.insert(processingJobs).values({
        kind: 'parcel_reconciliation',
        parcelId: parcel.id,
        attemptCount: -1,
      }),
    )
    await expectRejection(
      () => database.orm.insert(processingJobs).values({
        kind: 'parcel_reconciliation',
        parcelId: parcel.id,
        maxAttempts: 0,
      }),
    )
  })

  it('refuses to let its subject be deleted out from under it', async () => {
    const parcel = await insertParcel()
    const document = await insertDocument()

    await database.orm.insert(processingJobs).values({
      kind: 'document_extraction',
      parcelId: parcel.id,
      sourceDocumentId: document.id,
    })

    // An operational record that cannot say what it was for is not worth
    // keeping; the subject is retired rather than deleted.
    await expectRejection(
      () => database.orm.delete(sourceDocuments).where(eq(sourceDocuments.id, document.id)),
    )
    await expectRejection(
      () => database.orm.delete(parcels).where(eq(parcels.id, parcel.id)),
    )
  })
})

describe('readiness reports', () => {
  it('keeps checklist items with their report and refuses a negative order', async () => {
    const parcel = await insertParcel()
    const report = await firstOrThrow(
      await database.orm
        .insert(readinessReports)
        .values({
          parcelId: parcel.id,
          outcome: 'needs_review',
          rulesVersion: 'test-1',
          summary: 'Synthetic report for a schema check.',
        })
        .returning(),
    )

    const item = await firstOrThrow(
      await database.orm
        .insert(readinessChecklistItems)
        .values({
          reportId: report.id,
          ruleCode: 'RECORD_AREA_POSITIVE',
          outcome: 'pass',
          title: 'Area is positive',
          explanation: 'Synthetic checklist item.',
          sortOrder: 0,
        })
        .returning(),
    )

    await expectRejection(
      () => database.orm.insert(readinessChecklistItems).values({
        reportId: report.id,
        ruleCode: 'RECORD_SHARE_VALID',
        outcome: 'pass',
        title: 'Share is valid',
        explanation: 'Synthetic checklist item.',
        sortOrder: -1,
      }),
    )

    // Items are derived rows: the report owns them.
    await database.orm.delete(readinessReports).where(eq(readinessReports.id, report.id))
    const remaining = await database.orm
      .select()
      .from(readinessChecklistItems)
      .where(eq(readinessChecklistItems.id, item.id))
    expect(remaining).toEqual([])
  })

  it('refuses to delete the parcel a report describes', async () => {
    const parcel = await insertParcel()
    await database.orm.insert(readinessReports).values({
      parcelId: parcel.id,
      outcome: 'ready_for_review',
      rulesVersion: 'test-1',
      summary: 'Synthetic report for a schema check.',
    })

    await expectRejection(
      () => database.orm.delete(parcels).where(eq(parcels.id, parcel.id)),
    )
  })
})

describe('the version triggers', () => {
  it('advances a parcel version on any update and honours an explicit one', async () => {
    const parcel = await insertParcel()
    expect(parcel.version).toBe(1)

    const bumped = await firstOrThrow(
      await database.orm
        .update(parcels)
        .set({ areaDecimal: '130.0000' })
        .where(eq(parcels.id, parcel.id))
        .returning(),
    )
    expect(bumped.version).toBe(2)

    // An explicit version is kept, so a deliberate override remains possible.
    const explicit = await firstOrThrow(
      await database.orm
        .update(parcels)
        .set({ version: 9, areaDecimal: '131.0000' })
        .where(eq(parcels.id, parcel.id))
        .returning(),
    )
    expect(explicit.version).toBe(9)
  })

  it('advances a source document version on any update', async () => {
    const document = await insertDocument()
    expect(document.version).toBe(1)

    const bumped = await firstOrThrow(
      await database.orm
        .update(sourceDocuments)
        .set({ title: 'Renamed by the schema check.' })
        .where(eq(sourceDocuments.id, document.id))
        .returning(),
    )

    // This is the trigger migration 0007 added: without it the column existed
    // but never moved, so two editors would see the same revision number.
    expect(bumped.version).toBe(2)
  })

  it('advances an extraction version on any update', async () => {
    const parcel = await insertParcel()
    const extraction = await firstOrThrow(
      await database.orm
        .insert(extractions)
        .values({
          parcelId: parcel.id,
          field: 'area',
          recordedValue: '125.0000',
        })
        .returning(),
    )
    expect(extraction.version).toBe(1)

    const bumped = await firstOrThrow(
      await database.orm
        .update(extractions)
        .set({ reviewStatus: 'confirmed' })
        .where(eq(extractions.id, extraction.id))
        .returning(),
    )
    expect(bumped.version).toBe(2)
  })

  it('advances a finding version on any update', async () => {
    const parcel = await insertParcel()
    const finding = await firstOrThrow(
      await database.orm
        .insert(findings)
        .values({
          parcelId: parcel.id,
          kind: 'area_mismatch',
          severity: 'high',
          title: 'Synthetic finding',
          explanation: 'Synthetic finding for a schema check.',
        })
        .returning(),
    )
    expect(finding.version).toBe(1)

    const bumped = await firstOrThrow(
      await database.orm
        .update(findings)
        .set({ status: 'under_review' })
        .where(eq(findings.id, finding.id))
        .returning(),
    )
    expect(bumped.version).toBe(2)
  })
})

describe('provenance columns', () => {
  it('requires an origin and has no default that would guess one', async () => {
    // The column that distinguishes synthetic demonstration data from real
    // filings must be stated by the writer, never defaulted.
    const result = await database.pool.query<{ column_default: string | null; is_nullable: string }>(
      `select column_default, is_nullable from information_schema.columns
        where table_name = 'parcels' and column_name = 'origin'`,
    )

    expect(result.rows[0]?.is_nullable).toBe('NO')
    expect(result.rows[0]?.column_default).toBeNull()

    await expectRejection(
      () => database.orm.execute(
        sql`insert into parcels (survey, district, upazila, mouza, jl_number, khatian_number, area_decimal, share_numerator, share_denominator)
            values ('BS', 'D', 'U', 'M', ${`JL-${RUN}-x`}, ${`KH-${RUN}-x`}, '1.0000', 1, 2)`,
      ),
    )
  })
})
