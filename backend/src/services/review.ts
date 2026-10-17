import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'

import type { Database } from '../db/client.js'
import type {
  ExtractionReviewStatus,
  FindingKind,
  FindingSeverity,
  FindingStatus,
  ReviewOutcome,
} from '../db/schema/enums.js'
import { extractions, type Extraction } from '../db/schema/extractions.js'
import { findings, type Finding } from '../db/schema/findings.js'
import { parcels } from '../db/schema/parcels.js'
import { reviewDecisions, type ReviewDecision } from '../db/schema/reviews.js'
import type { User } from '../db/schema/users.js'
import {
  BadRequestError,
  ConcurrencyError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '../lib/errors.js'
import { AuditActions, recordAuditEvent } from './audit.js'
import { toExtractionView, type ExtractionView } from './extractions.js'

/**
 * The reviewer workflow.
 *
 * ## Append-only by construction
 *
 * A decision is never edited or replaced. Correcting an earlier decision appends
 * a new `review_decisions` row; the database enforces this with a trigger that
 * rejects `UPDATE` and `DELETE` on the table. The *mutable* state a decision
 * implies — an extraction's review status, a finding's status — is updated in the
 * same transaction, so the domain change and the record of who made it commit or
 * roll back together.
 *
 * ## Raw and reviewed values stay distinct
 *
 * `extractions.recorded_value` is never written by a review. A confirmation
 * leaves it as the accepted value (`review_status = 'confirmed'`,
 * `reviewed_value` null); a correction stores the new value in `reviewed_value`
 * and leaves the original untouched (`review_status = 'corrected'`). The
 * database check constraint enforces exactly that pairing, so the two can never
 * drift.
 *
 * ## Two reviewers cannot overwrite each other
 *
 * Every review states the `version` it read. The write is guarded on that
 * version, and a mismatch is a 409 rather than a silent overwrite. The version
 * is advanced by a database trigger, so it moves for any writer, not only this
 * service.
 */

export interface ReviewDecisionView {
  id: string
  findingId: string | null
  extractionId: string | null
  reviewerId: string
  outcome: ReviewOutcome
  /** The recorded value as it stood when the decision was taken. */
  extractedValue: string | null
  /** The reviewer's correction, present only for a correction. */
  proposedValue: string | null
  note: string | null
  createdAt: string
}

export interface FindingView {
  id: string
  parcelId: string
  kind: FindingKind
  severity: FindingSeverity
  status: FindingStatus
  title: string
  explanation: string
  ruleCode: string | null
  evidenceReference: string | null
  version: number
  createdAt: string
  updatedAt: string
}

/**
 * The public shape of a finding.
 *
 * A finding is presented as a discrepancy with an explanation, never as a
 * verdict: there is no field anywhere in this view that could be read as an
 * accusation of fraud or as a statement about ownership.
 */
export function toFindingView(finding: Finding): FindingView {
  return {
    id: finding.id,
    parcelId: finding.parcelId,
    kind: finding.kind,
    severity: finding.severity,
    status: finding.status,
    title: finding.title,
    explanation: finding.explanation,
    ruleCode: finding.ruleCode,
    evidenceReference: finding.evidenceReference,
    version: finding.version,
    createdAt: finding.createdAt.toISOString(),
    updatedAt: finding.updatedAt.toISOString(),
  }
}

export function toReviewDecisionView(decision: ReviewDecision): ReviewDecisionView {
  return {
    id: decision.id,
    findingId: decision.findingId,
    extractionId: decision.extractionId,
    reviewerId: decision.reviewerId,
    outcome: decision.outcome,
    extractedValue: decision.extractedValue,
    proposedValue: decision.proposedValue,
    note: decision.note,
    createdAt: decision.createdAt.toISOString(),
  }
}

/** Findings whose status is still changeable. */
const SETTLEABLE_FINDING_STATUSES: readonly FindingStatus[] = ['open', 'under_review']

function assertReviewer(user: User): void {
  if (user.role !== 'reviewer' && user.role !== 'admin') {
    throw new ForbiddenError('Only a reviewer may decide a review item.')
  }
}

/** Loads a finding the caller is allowed to see, following parcel ownership. */
export async function loadVisibleFinding(
  database: Database,
  user: User,
  findingId: string,
): Promise<Finding> {
  const rows = await database.orm
    .select({ finding: findings })
    .from(findings)
    .innerJoin(parcels, eq(parcels.id, findings.parcelId))
    .where(
      and(
        eq(findings.id, findingId),
        user.role === 'applicant' ? eq(parcels.ownerId, user.id) : undefined,
      ),
    )
    .limit(1)

  const row = rows[0]
  if (row === undefined) {
    throw new NotFoundError('No finding exists with that identifier.')
  }
  return row.finding
}

export type ExtractionReviewOutcome = 'verified' | 'correction' | 'needs_review'

export interface ReviewExtractionInput {
  reviewer: User
  extractionId: string
  outcome: ExtractionReviewOutcome
  /** Required for a correction; rejected for the other outcomes. */
  correctedValue?: string | null
  note?: string | null
  /** The version the reviewer read. */
  version: number
  requestId?: string | null
}

export interface ReviewExtractionResult {
  extraction: ExtractionView
  decision: ReviewDecisionView
}

/**
 * Records a reviewer's decision about one extracted value.
 *
 * A correction must actually differ from what was read: recording an identical
 * "correction" would add a misleading history entry claiming a change that did
 * not happen. A `needs_review` decision requires a note, because "somebody
 * looked and could not settle it" is only useful with a reason attached.
 */
export async function reviewExtraction(
  database: Database,
  input: ReviewExtractionInput,
): Promise<ReviewExtractionResult> {
  assertReviewer(input.reviewer)

  const rows = await database.orm
    .select({ extraction: extractions })
    .from(extractions)
    .innerJoin(parcels, eq(parcels.id, extractions.parcelId))
    .where(eq(extractions.id, input.extractionId))
    .limit(1)

  const existing = rows[0]?.extraction
  if (existing === undefined) {
    throw new NotFoundError('No extraction exists with that identifier.')
  }

  const corrected = input.correctedValue?.trim() ?? null

  if (input.outcome === 'correction') {
    if (corrected === null || corrected.length === 0) {
      throw new BadRequestError(
        'A correction must supply the value the reviewer accepts.',
      )
    }
    if (corrected === existing.recordedValue) {
      throw new BadRequestError(
        'The correction is identical to the recorded value. Confirm it instead of correcting it.',
      )
    }
  } else if (corrected !== null) {
    throw new BadRequestError(
      'Only a correction may supply a replacement value.',
    )
  }

  if (input.outcome === 'needs_review' && (input.note ?? '').trim().length === 0) {
    throw new BadRequestError(
      'Marking a value as needing further review requires a note explaining why.',
    )
  }

  const targetStatus: ExtractionReviewStatus =
    input.outcome === 'verified'
      ? 'confirmed'
      : input.outcome === 'correction'
        ? 'corrected'
        : 'unclear'

  const decisionOutcome: ReviewOutcome =
    input.outcome === 'verified' ? 'verified' : input.outcome === 'correction' ? 'correction' : 'needs_review'

  return database.orm.transaction(async (tx) => {
    const updated = await tx
      .update(extractions)
      .set({
        reviewStatus: targetStatus,
        // The raw reading is never overwritten: only a correction fills this in.
        reviewedValue: input.outcome === 'correction' ? corrected : null,
        reviewedBy: input.reviewer.id,
        reviewedAt: new Date(),
      })
      .where(
        and(
          eq(extractions.id, input.extractionId),
          eq(extractions.version, input.version),
        ),
      )
      .returning()

    const extraction = updated[0]
    if (extraction === undefined) {
      throw new ConcurrencyError(
        'This extracted value was reviewed by somebody else first. Reload it and try again.',
      )
    }

    const insertedDecision = await tx
      .insert(reviewDecisions)
      .values({
        extractionId: extraction.id,
        findingId: null,
        reviewerId: input.reviewer.id,
        outcome: decisionOutcome,
        // Snapshot of what was read, so the decision stays explicable even if
        // the extraction is later reviewed again.
        extractedValue: existing.recordedValue,
        proposedValue: input.outcome === 'correction' ? corrected : null,
        note: input.note ?? null,
      })
      .returning()

    const decision = insertedDecision[0]
    if (decision === undefined) {
      throw new Error('Review decision insert did not return the created row.')
    }

    await recordAuditEvent(tx, {
      actor: {
        kind: 'user',
        userId: input.reviewer.id,
        role: input.reviewer.role,
      },
      action:
        input.outcome === 'correction'
          ? AuditActions.extractionCorrected
          : AuditActions.reviewDecisionRecorded,
      entityType: 'extraction',
      entityId: extraction.id,
      summary: `Review decision "${decisionOutcome}" recorded for field "${extraction.field}".`,
      changes: {
        field: extraction.field,
        before: {
          reviewStatus: existing.reviewStatus,
          reviewedValue: existing.reviewedValue,
          version: existing.version,
        },
        after: {
          reviewStatus: extraction.reviewStatus,
          reviewedValue: extraction.reviewedValue,
          version: extraction.version,
        },
        note: input.note ?? null,
        decisionId: decision.id,
      },
      requestId: input.requestId ?? null,
    })

    return {
      extraction: toExtractionView(extraction),
      decision: toReviewDecisionView(decision),
    }
  })
}

export type FindingReviewAction = 'under_review' | 'resolved' | 'dismissed'

export interface ReviewFindingInput {
  reviewer: User
  findingId: string
  action: FindingReviewAction
  /** Required when settling; a dismissal must say why it was dismissed. */
  reason?: string | null
  version: number
  requestId?: string | null
}

export interface ReviewFindingResult {
  finding: FindingView
  decision: ReviewDecisionView
}

/**
 * Moves a finding forward.
 *
 * Settling requires a reason: a finding that is resolved or dismissed without
 * one is indistinguishable from a finding that was made to disappear. A settled
 * finding cannot be settled again, which keeps one finding to one decision and
 * leaves the append-only history unambiguous.
 */
export async function reviewFinding(
  database: Database,
  input: ReviewFindingInput,
): Promise<ReviewFindingResult> {
  assertReviewer(input.reviewer)

  const finding = await loadVisibleFinding(database, input.reviewer, input.findingId)
  const reason = input.reason?.trim() ?? null

  if (input.action === 'under_review' && finding.status !== 'open') {
    throw new ConflictError(
      `A finding that is already ${finding.status} cannot be placed under review.`,
    )
  }

  if (input.action !== 'under_review' && !SETTLEABLE_FINDING_STATUSES.includes(finding.status)) {
    throw new ConflictError(
      `This finding is already ${finding.status}. A settled finding is not settled twice; raise a new finding if the concern returns.`,
    )
  }

  if (input.action !== 'under_review' && (reason === null || reason.length === 0)) {
    throw new BadRequestError(
      'Resolving or dismissing a finding requires a recorded reason.',
    )
  }

  const targetStatus: FindingStatus =
    input.action === 'under_review'
      ? 'under_review'
      : input.action === 'resolved'
        ? 'resolved'
        : 'dismissed'

  // Both a resolution and a dismissal settle the matter, which the
  // `review_outcome` vocabulary expresses as `verified`. The distinction between
  // the two is preserved in the finding's own status and in the audit event,
  // which carries the structured before/after.
  const decisionOutcome: ReviewOutcome = 'verified'

  return database.orm.transaction(async (tx) => {
    const updated = await tx
      .update(findings)
      .set({ status: targetStatus })
      .where(
        and(eq(findings.id, input.findingId), eq(findings.version, input.version)),
      )
      .returning()

    const updatedFinding = updated[0]
    if (updatedFinding === undefined) {
      throw new ConcurrencyError(
        'This finding was changed by somebody else first. Reload it and try again.',
      )
    }

    const insertedDecision = await tx
      .insert(reviewDecisions)
      .values({
        findingId: updatedFinding.id,
        extractionId: null,
        reviewerId: input.reviewer.id,
        outcome: decisionOutcome,
        extractedValue: null,
        proposedValue: null,
        note: reason,
      })
      .returning()

    const decision = insertedDecision[0]
    if (decision === undefined) {
      throw new Error('Review decision insert did not return the created row.')
    }

    await recordAuditEvent(tx, {
      actor: {
        kind: 'user',
        userId: input.reviewer.id,
        role: input.reviewer.role,
      },
      action:
        input.action === 'resolved'
          ? AuditActions.findingResolved
          : AuditActions.reviewDecisionRecorded,
      entityType: 'finding',
      entityId: updatedFinding.id,
      summary: `Finding moved from ${finding.status} to ${targetStatus}.`,
      changes: {
        before: { status: finding.status, version: finding.version },
        after: { status: updatedFinding.status, version: updatedFinding.version },
        action: input.action,
        reason,
        decisionId: decision.id,
      },
      requestId: input.requestId ?? null,
    })

    return {
      finding: toFindingView(updatedFinding),
      decision: toReviewDecisionView(decision),
    }
  })
}

/** The append-only decision history for one extraction, oldest first. */
export async function listDecisionsForExtraction(
  database: Database,
  user: User,
  extractionId: string,
): Promise<ReviewDecisionView[]> {
  const rows = await database.orm
    .select({ decision: reviewDecisions })
    .from(reviewDecisions)
    .innerJoin(extractions, eq(extractions.id, reviewDecisions.extractionId))
    .innerJoin(parcels, eq(parcels.id, extractions.parcelId))
    .where(
      and(
        eq(reviewDecisions.extractionId, extractionId),
        user.role === 'applicant' ? eq(parcels.ownerId, user.id) : undefined,
      ),
    )
    .orderBy(asc(reviewDecisions.createdAt), asc(reviewDecisions.id))

  return rows.map((row) => toReviewDecisionView(row.decision))
}

/** The append-only decision history for one finding, oldest first. */
export async function listDecisionsForFinding(
  database: Database,
  user: User,
  findingId: string,
): Promise<ReviewDecisionView[]> {
  await loadVisibleFinding(database, user, findingId)

  const rows = await database.orm
    .select()
    .from(reviewDecisions)
    .where(eq(reviewDecisions.findingId, findingId))
    .orderBy(asc(reviewDecisions.createdAt), asc(reviewDecisions.id))

  return rows.map(toReviewDecisionView)
}

export interface ReviewQueue {
  pendingExtractions: ExtractionView[]
  openFindings: FindingView[]
  totals: { pendingExtractions: number; openFindings: number }
}

export interface ReviewQueueInput {
  limit: number
  offset: number
  parcelId?: string
  /** Restrict the finding side of the queue to one severity. */
  severity?: FindingSeverity
  /** Restrict the extraction side to a review status. */
  extractionStatus?: ExtractionReviewStatus
}

/**
 * The reviewer's work queue: values awaiting a decision and findings still open.
 *
 * Bounded on both sides. The default `extractionStatus` filter is "anything not
 * yet settled", because a reviewer's queue should contain outstanding work
 * rather than a full history.
 */
export async function loadReviewQueue(
  database: Database,
  input: ReviewQueueInput,
): Promise<ReviewQueue> {
  const unsettledStatuses: readonly ExtractionReviewStatus[] =
    input.extractionStatus === undefined
      ? ['pending', 'unclear']
      : [input.extractionStatus]

  const extractionWhere = and(
    inArray(extractions.reviewStatus, [...unsettledStatuses]),
    input.parcelId === undefined
      ? undefined
      : eq(extractions.parcelId, input.parcelId),
  )

  const findingWhere = and(
    inArray(findings.status, ['open', 'under_review']),
    input.parcelId === undefined ? undefined : eq(findings.parcelId, input.parcelId),
    input.severity === undefined ? undefined : eq(findings.severity, input.severity),
  )

  const [extractionRows, extractionTotal, findingRows, findingTotal] =
    await Promise.all([
      database.orm
        .select()
        .from(extractions)
        .where(extractionWhere)
        .orderBy(desc(extractions.createdAt), desc(extractions.id))
        .limit(input.limit)
        .offset(input.offset),
      database.orm
        .select({ count: sql<number>`count(*)::int` })
        .from(extractions)
        .where(extractionWhere),
      database.orm
        .select()
        .from(findings)
        .where(findingWhere)
        .orderBy(desc(findings.severity), desc(findings.createdAt))
        .limit(input.limit)
        .offset(input.offset),
      database.orm
        .select({ count: sql<number>`count(*)::int` })
        .from(findings)
        .where(findingWhere),
    ])

  return {
    pendingExtractions: extractionRows.map(toExtractionView),
    openFindings: findingRows.map(toFindingView),
    totals: {
      pendingExtractions: extractionTotal[0]?.count ?? 0,
      openFindings: findingTotal[0]?.count ?? 0,
    },
  }
}

/** Lists findings for a visible parcel. */
export async function listFindingsForParcel(
  database: Database,
  user: User,
  parcelId: string,
): Promise<Finding[]> {
  const rows = await database.orm
    .select({ finding: findings })
    .from(findings)
    .innerJoin(parcels, eq(parcels.id, findings.parcelId))
    .where(
      and(
        eq(findings.parcelId, parcelId),
        user.role === 'applicant' ? eq(parcels.ownerId, user.id) : undefined,
      ),
    )
    .orderBy(desc(findings.severity), asc(findings.createdAt))

  return rows.map((row) => row.finding)
}

/** A finding plus its decision history, for the review detail view. */
export async function loadFindingDetail(
  database: Database,
  user: User,
  findingId: string,
): Promise<{ finding: Finding; decisions: ReviewDecisionView[] }> {
  const finding = await loadVisibleFinding(database, user, findingId)
  const decisions = await listDecisionsForFinding(database, user, findingId)
  return { finding, decisions }
}

/** Re-exported so routes do not need to reach into the schema. */
export type ReviewableExtraction = Extraction
