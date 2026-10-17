import { pgEnum } from 'drizzle-orm/pg-core'

/**
 * Enumerated value sets that are stable across the domain.
 *
 * Free-form or rapidly evolving vocabularies (for example audit actions) are
 * stored as `text` instead, so that adding a new value does not require a
 * database migration.
 */

/** Least-privilege default is `applicant`; roles are never self-assigned. */
export const userRoleEnum = pgEnum('user_role', [
  'applicant',
  'reviewer',
  'admin',
])

export const userStatusEnum = pgEnum('user_status', ['active', 'suspended'])

/** Cadastral survey series: CS (1924), SA (1962), RS (1988), BS (2016). */
export const surveyVersionEnum = pgEnum('survey_version', [
  'CS',
  'SA',
  'RS',
  'BS',
])

export const lineageRelationEnum = pgEnum('lineage_relation', [
  'continued',
  'renumbered',
  'split',
  'merge',
])

/** How well a lineage link is evidenced. Absence of evidence is `unverified`. */
export const lineageCertaintyEnum = pgEnum('lineage_certainty', [
  'confirmed',
  'illustrative',
  'unverified',
])

export const sourceDocumentKindEnum = pgEnum('source_document_kind', [
  'synthetic_demo',
  'manual_entry',
  'external_reference',
])

export const documentStatusEnum = pgEnum('document_status', [
  'requested',
  'in_review',
  'submitted',
])

/** Fields that can be extracted from a record and reviewed. */
export const extractionFieldEnum = pgEnum('extraction_field', [
  'khatian',
  'mouza',
  'dag',
  'area',
  'share',
  'owner',
])

/** Review state of a single extracted value. */
export const extractionReviewStatusEnum = pgEnum('extraction_review_status', [
  'pending',
  'confirmed',
  'corrected',
  'unclear',
])

/** Findings are review prompts, never determinations of fraud. */
export const findingKindEnum = pgEnum('finding_kind', [
  'area_mismatch',
  'share_mismatch',
  'dag_mismatch',
  'khatian_mismatch',
  'mouza_mismatch',
  'lineage_break',
  'unclear_reading',
  'other',
])

export const findingSeverityEnum = pgEnum('finding_severity', [
  'info',
  'low',
  'medium',
  'high',
])

export const findingStatusEnum = pgEnum('finding_status', [
  'open',
  'under_review',
  'resolved',
  'dismissed',
])

export const reviewOutcomeEnum = pgEnum('review_outcome', [
  'verified',
  'correction',
  'needs_review',
])

/**
 * Where a record came from.
 *
 * `synthetic_demo` marks the seeded demo dataset; `user_created` marks anything
 * a real account created through the API. The distinction is required so demo
 * fixtures and user-owned records can never be confused, and so that demo data
 * is not treated as somebody's filing. There is deliberately no database default
 * for columns using this type: a writer must state which it is, rather than
 * inheriting a classification silently.
 */
export const dataOriginEnum = pgEnum('data_origin', [
  'synthetic_demo',
  'user_created',
])

/** Kind of background work a processing job represents. */
export const processingJobKindEnum = pgEnum('processing_job_kind', [
  'document_extraction',
  'parcel_reconciliation',
  'readiness_report',
])

/** Lifecycle of a processing job. Transitions are enforced in the service. */
export const processingJobStatusEnum = pgEnum('processing_job_status', [
  'queued',
  'processing',
  'review_required',
  'completed',
  'failed',
  'retry_pending',
  'cancelled',
])

/** Overall verdict of a mutation-readiness report. */
export const readinessOutcomeEnum = pgEnum('readiness_outcome', [
  'ready_for_review',
  'needs_review',
  'not_ready',
])

/** Outcome of one checklist item inside a readiness report. */
export const checklistOutcomeEnum = pgEnum('checklist_outcome', [
  'pass',
  'fail',
  'needs_review',
  'not_applicable',
])

/**
 * Lifecycle of a parcel record.
 *
 * `retired` is the non-destructive alternative to deletion. A parcel is never
 * hard-deleted: it is withdrawn from active use while its evidence, lineage,
 * findings, and reviews stay readable. There is no delete endpoint anywhere in
 * the API, which is why this exists.
 */
export const parcelLifecycleEnum = pgEnum('parcel_lifecycle', [
  'active',
  'retired',
])

/**
 * TypeScript aliases for the enumerated sets.
 *
 * These are derived from the `pgEnum` definitions above rather than written out
 * again, so a migration that adds a member widens the TypeScript type at the same
 * moment. Everywhere else in the codebase refers to `ExtractionField` or
 * `UserRole` rather than repeating a string union, which is what keeps the
 * service layer and the database from drifting apart.
 */
export type UserRole = (typeof userRoleEnum.enumValues)[number]
export type UserStatus = (typeof userStatusEnum.enumValues)[number]
export type SurveyVersion = (typeof surveyVersionEnum.enumValues)[number]
export type LineageRelation = (typeof lineageRelationEnum.enumValues)[number]
export type LineageCertainty = (typeof lineageCertaintyEnum.enumValues)[number]
export type SourceDocumentKind = (typeof sourceDocumentKindEnum.enumValues)[number]
export type DocumentStatus = (typeof documentStatusEnum.enumValues)[number]
export type ExtractionField = (typeof extractionFieldEnum.enumValues)[number]
export type ExtractionReviewStatus =
  (typeof extractionReviewStatusEnum.enumValues)[number]
export type FindingKind = (typeof findingKindEnum.enumValues)[number]
export type FindingSeverity = (typeof findingSeverityEnum.enumValues)[number]
export type FindingStatus = (typeof findingStatusEnum.enumValues)[number]
export type ReviewOutcome = (typeof reviewOutcomeEnum.enumValues)[number]
export type DataOrigin = (typeof dataOriginEnum.enumValues)[number]
export type ProcessingJobKind = (typeof processingJobKindEnum.enumValues)[number]
export type ProcessingJobStatus =
  (typeof processingJobStatusEnum.enumValues)[number]
export type ReadinessOutcome = (typeof readinessOutcomeEnum.enumValues)[number]
export type ChecklistOutcome = (typeof checklistOutcomeEnum.enumValues)[number]
export type ParcelLifecycle = (typeof parcelLifecycleEnum.enumValues)[number]
