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
