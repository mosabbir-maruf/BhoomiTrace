import { and, asc, desc, eq, sql } from 'drizzle-orm'

import type { Database } from '../db/client.js'
import type {
  ExtractionField,
  ExtractionReviewStatus,
} from '../db/schema/enums.js'
import {
  extractions,
  type Extraction,
} from '../db/schema/extractions.js'
import { documentPages } from '../db/schema/pages.js'
import { parcels } from '../db/schema/parcels.js'
import type { BoundingBox } from '../db/schema/types.js'
import type { User } from '../db/schema/users.js'
import type { ExtractedField, ExtractionResult } from '../extraction/provider.js'
import { BadRequestError, NotFoundError } from '../lib/errors.js'
import { AuditActions, recordAuditEvent, systemActor, type AuditActor } from './audit.js'
import { loadVisibleParcel } from './parcels.js'

/**
 * Extracted values: what was read, and what a reviewer decided about it.
 *
 * The central distinction this module protects is between `recordedValue` and
 * `reviewedValue`. `recordedValue` is what a provider read or a person typed;
 * it is never overwritten. A reviewer's disagreement goes into `reviewedValue`
 * and `reviewStatus`, so the original reading stays available forever. The
 * database enforces the pairing with a check constraint, and the append-only
 * `review_decisions` table holds the reasoning.
 *
 * `sourceDocumentId` may be null. A manual-entry extraction is not a second-class
 * record: it is the normal case for a value a reviewer read off a paper record
 * the platform does not hold a scan of.
 */

export interface ExtractionView {
  id: string
  parcelId: string
  /** Null for a manual entry recorded without a source document. */
  sourceDocumentId: string | null
  pageId: string | null
  field: ExtractionField
  /** Exactly what was read. Never modified by review. */
  recordedValue: string
  /** A reviewer's accepted or corrected value. Null until reviewed. */
  reviewedValue: string | null
  reviewStatus: ExtractionReviewStatus
  /** Exact decimal string, or null when no confidence was reported. */
  confidence: string | null
  isUnclear: boolean
  pageReference: string | null
  boundingBox: BoundingBox | null
  /** Name of the provider that produced the read; null for manual entry. */
  provider: string | null
  providerModel: string | null
  /**
   * `manual_entry` when no provider produced the value, `provider` otherwise.
   *
   * Derived rather than stored, so there is one unambiguous meaning for a null
   * provider and no separate column to drift out of sync.
   */
  origin: 'manual_entry' | 'provider'
  extractedAt: string | null
  reviewedBy: string | null
  reviewedAt: string | null
  version: number
  createdAt: string
  updatedAt: string
}

export function toExtractionView(extraction: Extraction): ExtractionView {
  return {
    id: extraction.id,
    parcelId: extraction.parcelId,
    sourceDocumentId: extraction.sourceDocumentId,
    pageId: extraction.pageId,
    field: extraction.field,
    recordedValue: extraction.recordedValue,
    reviewedValue: extraction.reviewedValue,
    reviewStatus: extraction.reviewStatus,
    confidence: extraction.confidence,
    isUnclear: extraction.isUnclear,
    pageReference: extraction.pageReference,
    boundingBox: extraction.boundingBox ?? null,
    provider: extraction.provider,
    providerModel: extraction.providerModel,
    origin: extraction.provider === null ? 'manual_entry' : 'provider',
    extractedAt: extraction.extractedAt?.toISOString() ?? null,
    reviewedBy: extraction.reviewedBy,
    reviewedAt: extraction.reviewedAt?.toISOString() ?? null,
    version: extraction.version,
    createdAt: extraction.createdAt.toISOString(),
    updatedAt: extraction.updatedAt.toISOString(),
  }
}

/**
 * Loads an extraction the caller is allowed to see.
 *
 * Visibility follows the parcel: an applicant sees extractions only for parcels
 * they own, so an extraction identifier cannot be used to reach another
 * person's record.
 */
export async function loadVisibleExtraction(
  database: Database,
  user: User,
  extractionId: string,
): Promise<Extraction> {
  const rows = await database.orm
    .select({ extraction: extractions })
    .from(extractions)
    .innerJoin(parcels, eq(parcels.id, extractions.parcelId))
    .where(
      and(
        eq(extractions.id, extractionId),
        user.role === 'applicant' ? eq(parcels.ownerId, user.id) : undefined,
      ),
    )
    .limit(1)

  const row = rows[0]
  if (row === undefined) {
    throw new NotFoundError('No extraction exists with that identifier.')
  }
  return row.extraction
}

/** Lists a visible parcel's extractions, oldest first. */
export async function listExtractionsForParcel(
  database: Database,
  user: User,
  parcelId: string,
): Promise<ExtractionView[]> {
  await loadVisibleParcel(database, user, parcelId)

  const rows = await database.orm
    .select()
    .from(extractions)
    .where(eq(extractions.parcelId, parcelId))
    .orderBy(asc(extractions.createdAt), asc(extractions.id))

  return rows.map(toExtractionView)
}

/** Extractions whose field identity repeats are listed for a reviewer to judge. */
export async function listPendingExtractions(
  database: Database,
  options: { limit: number; offset: number; parcelId?: string },
): Promise<{ rows: Extraction[]; total: number }> {
  const where =
    options.parcelId === undefined
      ? eq(extractions.reviewStatus, 'pending')
      : and(
          eq(extractions.reviewStatus, 'pending'),
          eq(extractions.parcelId, options.parcelId),
        )

  const [rows, counted] = await Promise.all([
    database.orm
      .select()
      .from(extractions)
      .where(where)
      .orderBy(desc(extractions.createdAt), desc(extractions.id))
      .limit(options.limit)
      .offset(options.offset),
    database.orm
      .select({ count: sql<number>`count(*)::int` })
      .from(extractions)
      .where(where),
  ])

  return { rows, total: counted[0]?.count ?? 0 }
}

export interface ManualExtractionInput {
  user: User
  parcelId: string
  field: ExtractionField
  recordedValue: string
  pageReference?: string | null
  isUnclear?: boolean
  requestId?: string | null
}

/**
 * Records a value a person read directly.
 *
 * `provider` and `extractedAt` stay null: no provider produced this value, and
 * recording a provider name would misrepresent where it came from. The audit
 * event names the human who entered it.
 */
export async function recordManualExtraction(
  database: Database,
  input: ManualExtractionInput,
): Promise<ExtractionView> {
  await loadVisibleParcel(database, input.user, input.parcelId)

  const recordedValue = input.recordedValue.trim()
  if (recordedValue.length === 0 && input.isUnclear !== true) {
    throw new BadRequestError(
      'A recorded value is required unless the entry is marked unclear.',
    )
  }

  return database.orm.transaction(async (tx) => {
    const inserted = await tx
      .insert(extractions)
      .values({
        parcelId: input.parcelId,
        sourceDocumentId: null,
        field: input.field,
        recordedValue,
        reviewStatus: input.isUnclear === true ? 'unclear' : 'pending',
        confidence: null,
        isUnclear: input.isUnclear === true,
        pageReference: input.pageReference ?? null,
        provider: null,
        providerModel: null,
        extractedAt: null,
      })
      .returning()

    const extraction = inserted[0]
    if (extraction === undefined) {
      throw new Error('Extraction insert did not return the created row.')
    }

    await recordAuditEvent(tx, {
      actor: { kind: 'user', userId: input.user.id, role: input.user.role },
      action: AuditActions.extractionRecorded,
      entityType: 'extraction',
      entityId: extraction.id,
      summary: `Manual entry recorded for field "${extraction.field}".`,
      changes: {
        parcelId: input.parcelId,
        field: extraction.field,
        isUnclear: extraction.isUnclear,
        origin: 'manual_entry',
      },
      requestId: input.requestId ?? null,
    })

    return toExtractionView(extraction)
  })
}

export interface PersistExtractionResultInput {
  result: ExtractionResult
  parcelId: string
  sourceDocumentId: string | null
  /** Actor recorded on the audit row. The worker acts on a user's behalf. */
  actor: AuditActor
  requestId?: string | null
}

/**
 * The database surface this module needs.
 *
 * Narrower than `Database`, so a caller can pass either the pooled client or an
 * open transaction. Persisting provider readings must be able to join the
 * transaction that records the job's outcome, so that "extractions written" and
 * "job completed" are one atomic fact.
 */
export type ExtractionExecutor = Pick<Database['orm'], 'insert' | 'select'>

/**
 * Stores a provider's readings as extraction rows.
 *
 * Runs inside the caller's transaction so that a job's extractions and the job's
 * own completion are one atomic unit. Page numbers are resolved against the
 * document's recorded pages: a provider that names a page the document does not
 * have produces an extraction with no `pageId` rather than a fabricated page
 * row, because inventing structure to satisfy a foreign key would manufacture
 * evidence.
 */
export async function persistExtractionResult(
  database: ExtractionExecutor,
  input: PersistExtractionResultInput,
): Promise<Extraction[]> {
  const pageIdsByNumber = new Map<number, string>()

  if (input.sourceDocumentId !== null) {
    const pages = await database
      .select({ id: documentPages.id, pageNumber: documentPages.pageNumber })
      .from(documentPages)
      .where(eq(documentPages.sourceDocumentId, input.sourceDocumentId))

    for (const page of pages) pageIdsByNumber.set(page.pageNumber, page.id)
  }

  const values = input.result.fields.map((field: ExtractedField) => ({
    parcelId: input.parcelId,
    sourceDocumentId: input.sourceDocumentId,
    pageId:
      field.pageNumber === null
        ? null
        : (pageIdsByNumber.get(field.pageNumber) ?? null),
    field: field.field,
    recordedValue: field.value,
    // Never reviewed at insert time: a provider read is always pending.
    reviewStatus:
      field.isUnclear || field.value.length === 0
        ? ('unclear' as const)
        : ('pending' as const),
    confidence: field.confidence === null ? null : field.confidence.toString(),
    isUnclear: field.isUnclear || field.value.length === 0,
    pageReference: field.pageReference,
    boundingBox: field.boundingBox,
    provider: input.result.provider,
    providerModel: input.result.model,
    extractedAt: input.result.extractedAt,
  }))

  if (values.length === 0) return []

  const inserted = await database
    .insert(extractions)
    .values(values)
    .returning()

  await recordAuditEvent(database, {
    actor: input.actor,
    action: AuditActions.extractionRecorded,
    entityType: 'parcel',
    entityId: input.parcelId,
    summary: `Provider "${input.result.provider}" recorded ${inserted.length} extracted value(s).`,
    changes: {
      provider: input.result.provider,
      model: input.result.model,
      fields: inserted.map((row) => row.field),
      unclearCount: inserted.filter((row) => row.isUnclear).length,
      warnings: input.result.warnings,
    },
    requestId: input.requestId ?? null,
  })

  return inserted
}

/** Counts extractions by review status for a parcel. */
export async function reviewStatusCounts(
  database: Database,
  parcelId: string,
): Promise<Record<ExtractionReviewStatus, number>> {
  const rows = await database.orm
    .select({
      status: extractions.reviewStatus,
      count: sql<number>`count(*)::int`,
    })
    .from(extractions)
    .where(eq(extractions.parcelId, parcelId))
    .groupBy(extractions.reviewStatus)

  const counts: Record<ExtractionReviewStatus, number> = {
    pending: 0,
    confirmed: 0,
    corrected: 0,
    unclear: 0,
  }

  for (const row of rows) counts[row.status] = row.count
  return counts
}

/** A system actor used when a job runs without a requesting user. */
export function extractionSystemActor(subsystem = 'extraction-worker') {
  return systemActor(subsystem)
}
