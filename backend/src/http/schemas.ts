import { z } from 'zod'

import {
  applicationStatusEnum,
  applicationTypeEnum,
  checklistOutcomeEnum,
  documentStatusEnum,
  extractionFieldEnum,
  extractionReviewStatusEnum,
  findingKindEnum,
  findingReviewActionEnum,
  findingSeverityEnum,
  findingStatusEnum,
  lineageCertaintyEnum,
  lineageRelationEnum,
  parcelLifecycleEnum,
  processingJobKindEnum,
  processingJobStatusEnum,
  readinessOutcomeEnum,
  reviewOutcomeEnum,
  sourceDocumentKindEnum,
  surveyVersionEnum,
  userRoleEnum,
  userStatusEnum,
} from '../db/schema/enums.js'
import { paginationQuerySchema } from '../lib/pagination.js'

/**
 * Request and response schemas for the whole API.
 *
 * Enum members are derived from the database `pgEnum` definitions rather than
 * retyped. A migration that adds a member therefore changes the API contract in
 * exactly one place, and a route can never accept a value the database would
 * reject.
 *
 * Response schemas are declared for every endpoint. That is worth the verbosity
 * for two reasons: Fastify's serializer drops fields that are not in the schema,
 * so an accidental `password_hash` or `storage_key` cannot reach a caller even
 * if a service starts returning it; and the OpenAPI document is generated from
 * these same schemas, so the published contract cannot drift from the enforced
 * one.
 */

/* -------------------------------------------------------------------------- */
/* Error envelope                                                              */
/* -------------------------------------------------------------------------- */

export const errorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    requestId: z.string(),
    details: z.unknown().optional(),
  }),
})

export const errorResponses = {
  400: errorEnvelopeSchema,
  401: errorEnvelopeSchema,
  403: errorEnvelopeSchema,
  404: errorEnvelopeSchema,
  409: errorEnvelopeSchema,
  413: errorEnvelopeSchema,
  415: errorEnvelopeSchema,
  422: errorEnvelopeSchema,
  429: errorEnvelopeSchema,
  500: errorEnvelopeSchema,
} as const

/**
 * A UUID path parameter, keyed by its literal name.
 *
 * The generic parameter is what makes this usable: `uuidParam('parcelId')` gives
 * `z.object({ parcelId: z.uuid() })`, so a handler receives `params.parcelId` as
 * a `string`. Without it, the computed key collapses into an index signature and
 * every parameter reads as `string | undefined`. The single cast is required
 * because TypeScript widens a computed key in a generic function body; it is
 * sound because `z.object` output carries exactly the keys passed in. A call
 * with a non-literal name widens `Name` to `string`, which brings the index
 * signature back and makes the mistake a compile error at the call site.
 */
export const uuidParam = <Name extends string>(
  name: Name,
): z.ZodObject<{ [Key in Name]: z.ZodUUID }> =>
  z.object({ [name]: z.uuid() }) as unknown as z.ZodObject<{
    [Key in Name]: z.ZodUUID
  }>

/**
 * The shared pagination fields, reused by every list query.
 *
 * Derived from the same definition the services bound their results with, so a
 * query cannot be accepted here and then rejected there.
 */
export const paginationQuery = paginationQuerySchema

/** Wraps an item schema in the standard page envelope. */
export const pageOf = <T extends z.ZodType>(item: T) =>
  z.object({
    items: z.array(item),
    total: z.number().int(),
    limit: z.number().int(),
    offset: z.number().int(),
    hasMore: z.boolean(),
  })

const isoDate = z.string()

/* -------------------------------------------------------------------------- */
/* Shared value objects                                                        */
/* -------------------------------------------------------------------------- */

export const boundingBoxSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
})

export const recordReferenceSchema = z.object({
  entityType: z.string(),
  entityId: z.string(),
  label: z.string().optional(),
})

/* -------------------------------------------------------------------------- */
/* Authentication                                                              */
/* -------------------------------------------------------------------------- */

export const userRoleSchema = z.enum(userRoleEnum.enumValues)
export const userStatusSchema = z.enum(userStatusEnum.enumValues)

export const publicUserSchema = z.object({
  id: z.uuid(),
  email: z.string(),
  displayName: z.string(),
  role: userRoleSchema,
  status: userStatusSchema,
  createdAt: isoDate,
})

export const registerBodySchema = z.object({
  email: z.email().max(320),
  displayName: z.string().trim().min(1).max(120),
  // Only a length policy is enforced here; the deep check lives in the password
  // module so that one place decides what an acceptable password is.
  password: z.string().min(1).max(256),
})

export const loginBodySchema = z.object({
  email: z.email().max(320),
  password: z.string().min(1).max(256),
})

/** The session payload returned by register and login. */
export const sessionResponseSchema = z.object({
  user: publicUserSchema,
  /** The CSRF token, echoed for non-browser clients that cannot read cookies. */
  csrfToken: z.string(),
  expiresAt: isoDate,
})

/* -------------------------------------------------------------------------- */
/* Parcels                                                                     */
/* -------------------------------------------------------------------------- */

export const surveyVersionSchema = z.enum(surveyVersionEnum.enumValues)
export const parcelLifecycleSchema = z.enum(parcelLifecycleEnum.enumValues)
export const dataOriginSchema = z.enum(['synthetic_demo', 'user_created'])

export const parcelSchema = z.object({
  id: z.uuid(),
  ownerId: z.uuid().nullable(),
  origin: dataOriginSchema,
  lifecycle: parcelLifecycleSchema,
  survey: surveyVersionSchema,
  khatianNumber: z.string(),
  mouza: z.string(),
  jlNumber: z.string(),
  upazila: z.string(),
  district: z.string(),
  /** Exact decimal string. Never a float: see the service's note. */
  areaDecimal: z.string(),
  shareNumerator: z.number().int(),
  shareDenominator: z.number().int(),
  ownershipShare: z.string(),
  dagNumbers: z.array(z.string()),
  version: z.number().int(),
  retirementReason: z.string().nullable(),
  retiredAt: isoDate.nullable(),
  createdAt: isoDate,
  updatedAt: isoDate,
})

export const parcelListQuerySchema = paginationQuery.extend({
  survey: surveyVersionSchema.optional(),
  district: z.string().min(1).max(120).optional(),
  upazila: z.string().min(1).max(120).optional(),
  mouza: z.string().min(1).max(120).optional(),
  khatianNumber: z.string().min(1).max(64).optional(),
  lifecycle: parcelLifecycleSchema.optional(),
  origin: dataOriginSchema.optional(),
})

const decimalArea = z
  .string()
  .regex(/^\d+(\.\d{1,4})?$/, 'must be a decimal number with at most 4 decimal places')

export const createParcelBodySchema = z.object({
  survey: surveyVersionSchema,
  khatianNumber: z.string().trim().min(1).max(64),
  mouza: z.string().trim().min(1).max(120),
  jlNumber: z.string().trim().min(1).max(64),
  upazila: z.string().trim().min(1).max(120),
  district: z.string().trim().min(1).max(120),
  areaDecimal: decimalArea,
  shareNumerator: z.number().int().min(0).max(1_000_000_000).default(1),
  shareDenominator: z.number().int().min(1).max(1_000_000_000).default(1),
  dagNumbers: z.array(z.string().trim().min(1).max(64)).max(50).default([]),
  /** Only an administrator may set this; ignored for everybody else. */
  ownerId: z.uuid().nullable().optional(),
})

export const updateParcelBodySchema = z.object({
  /** Optimistic-concurrency token: the version the caller last read. */
  version: z.number().int().min(1),
  areaDecimal: decimalArea.optional(),
  shareNumerator: z.number().int().min(0).max(1_000_000_000).optional(),
  shareDenominator: z.number().int().min(1).max(1_000_000_000).optional(),
  mouza: z.string().trim().min(1).max(120).optional(),
  jlNumber: z.string().trim().min(1).max(64).optional(),
  upazila: z.string().trim().min(1).max(120).optional(),
  district: z.string().trim().min(1).max(120).optional(),
  dagNumbers: z.array(z.string().trim().min(1).max(64)).max(50).optional(),
})

export const lifecycleBodySchema = z.object({
  version: z.number().int().min(1),
  reason: z.string().trim().min(3).max(500),
})

/* -------------------------------------------------------------------------- */
/* Lineage                                                                     */
/* -------------------------------------------------------------------------- */

export const lineageRelationSchema = z.enum(lineageRelationEnum.enumValues)
export const lineageCertaintySchema = z.enum(lineageCertaintyEnum.enumValues)

export const lineageLinkSchema = z.object({
  id: z.uuid(),
  fromParcelId: z.uuid(),
  toParcelId: z.uuid(),
  relation: lineageRelationSchema,
  certainty: lineageCertaintySchema,
  evidenceReference: z.string().nullable(),
  note: z.string().nullable(),
  createdAt: isoDate,
})

export const lineageArithmeticNoteSchema = z.object({
  ruleCode: z.string(),
  relation: lineageRelationSchema,
  observedParts: z.array(z.string()),
  observedTotal: z.string(),
  expectedTotal: z.string(),
  exactlyEqual: z.boolean(),
  explanation: z.string(),
})

export const createLineageBodySchema = z.object({
  toParcelId: z.uuid(),
  relation: lineageRelationSchema,
  certainty: lineageCertaintySchema.default('unverified'),
  evidenceReference: z.string().trim().max(500).nullable().optional(),
  note: z.string().trim().max(1_000).nullable().optional(),
})

export const lineageCertaintyBodySchema = z.object({
  certainty: lineageCertaintySchema,
  evidenceReference: z.string().trim().max(500).nullable().optional(),
})

export const lineageListSchema = z.object({
  outgoing: z.array(lineageLinkSchema),
  incoming: z.array(lineageLinkSchema),
  arithmetic: z.array(lineageArithmeticNoteSchema),
})

/* -------------------------------------------------------------------------- */
/* Documents                                                                   */
/* -------------------------------------------------------------------------- */

export const documentKindSchema = z.enum(sourceDocumentKindEnum.enumValues)
export const documentStatusSchema = z.enum(documentStatusEnum.enumValues)

export const documentPageSchema = z.object({
  id: z.uuid(),
  pageNumber: z.number().int(),
  label: z.string().nullable(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  region: boundingBoxSchema.nullable(),
})

export const documentSchema = z.object({
  id: z.uuid(),
  ownerId: z.uuid().nullable(),
  origin: dataOriginSchema,
  title: z.string(),
  kind: documentKindSchema,
  reference: z.string().nullable(),
  pageCount: z.number().int().nullable(),
  checksumSha256: z.string().nullable(),
  status: documentStatusSchema,
  contentType: z.string().nullable(),
  byteSize: z.number().int().nullable(),
  originalFilename: z.string().nullable(),
  /** The internal storage key is deliberately absent from this schema. */
  hasStoredFile: z.boolean(),
  version: z.number().int(),
  createdAt: isoDate,
  updatedAt: isoDate,
})

export const documentListQuerySchema = paginationQuery.extend({
  status: documentStatusSchema.optional(),
  kind: documentKindSchema.optional(),
  reference: z.string().min(1).max(200).optional(),
  title: z.string().min(1).max(200).optional(),
  origin: dataOriginSchema.optional(),
})

export const registerDocumentBodySchema = z.object({
  title: z.string().trim().min(1).max(300),
  kind: documentKindSchema,
  reference: z.string().trim().max(200).nullable().optional(),
  pageCount: z.number().int().min(0).max(10_000).nullable().optional(),
  status: documentStatusSchema.optional(),
  ownerId: z.uuid().nullable().optional(),
  pages: z
    .array(
      z.object({
        pageNumber: z.number().int().min(1).max(10_000),
        label: z.string().trim().max(200).nullable().optional(),
        width: z.number().int().positive().nullable().optional(),
        height: z.number().int().positive().nullable().optional(),
        region: boundingBoxSchema.nullable().optional(),
      }),
    )
    .max(200)
    .optional(),
})

export const updateDocumentBodySchema = z.object({
  version: z.number().int().min(1),
  title: z.string().trim().min(1).max(300).optional(),
  reference: z.string().trim().max(200).nullable().optional(),
  pageCount: z.number().int().min(0).max(10_000).nullable().optional(),
  status: documentStatusSchema.optional(),
})

export const addPageBodySchema = z.object({
  pageNumber: z.number().int().min(1).max(10_000),
  label: z.string().trim().max(200).nullable().optional(),
  width: z.number().int().positive().nullable().optional(),
  height: z.number().int().positive().nullable().optional(),
  region: boundingBoxSchema.nullable().optional(),
})

export const uploadQuerySchema = z.object({
  title: z.string().trim().min(1).max(300),
  kind: documentKindSchema,
  reference: z.string().trim().max(200).optional(),
  status: documentStatusSchema.optional(),
})

/* -------------------------------------------------------------------------- */
/* Extractions                                                                 */
/* -------------------------------------------------------------------------- */

export const extractionFieldSchema = z.enum(extractionFieldEnum.enumValues)
export const extractionReviewStatusSchema = z.enum(
  extractionReviewStatusEnum.enumValues,
)

export const extractionSchema = z.object({
  id: z.uuid(),
  parcelId: z.uuid(),
  sourceDocumentId: z.uuid().nullable(),
  pageId: z.uuid().nullable(),
  field: extractionFieldSchema,
  recordedValue: z.string(),
  reviewedValue: z.string().nullable(),
  reviewStatus: extractionReviewStatusSchema,
  confidence: z.string().nullable(),
  isUnclear: z.boolean(),
  pageReference: z.string().nullable(),
  boundingBox: boundingBoxSchema.nullable(),
  provider: z.string().nullable(),
  providerModel: z.string().nullable(),
  origin: z.enum(['manual_entry', 'provider']),
  extractedAt: isoDate.nullable(),
  reviewedBy: z.uuid().nullable(),
  reviewedAt: isoDate.nullable(),
  version: z.number().int(),
  createdAt: isoDate,
  updatedAt: isoDate,
})

export const manualExtractionBodySchema = z.object({
  field: extractionFieldSchema,
  recordedValue: z.string().trim().max(500),
  pageReference: z.string().trim().max(200).nullable().optional(),
  isUnclear: z.boolean().optional(),
})

/* -------------------------------------------------------------------------- */
/* Findings and review                                                         */
/* -------------------------------------------------------------------------- */

export const findingKindSchema = z.enum(findingKindEnum.enumValues)
export const findingSeveritySchema = z.enum(findingSeverityEnum.enumValues)
export const findingStatusSchema = z.enum(findingStatusEnum.enumValues)
export const reviewOutcomeSchema = z.enum(reviewOutcomeEnum.enumValues)
export const findingReviewActionSchema = z.enum(
  findingReviewActionEnum.enumValues,
)

export const findingSchema = z.object({
  id: z.uuid(),
  parcelId: z.uuid(),
  kind: findingKindSchema,
  severity: findingSeveritySchema,
  status: findingStatusSchema,
  title: z.string(),
  explanation: z.string(),
  ruleCode: z.string().nullable(),
  evidenceReference: z.string().nullable(),
  version: z.number().int(),
  createdAt: isoDate,
  updatedAt: isoDate,
})

export const reviewDecisionSchema = z.object({
  id: z.uuid(),
  findingId: z.uuid().nullable(),
  extractionId: z.uuid().nullable(),
  reviewerId: z.uuid(),
  outcome: reviewOutcomeSchema,
  /**
   * The action taken on a finding: `under_review`, `resolved`, or `dismissed`.
   *
   * Null for an extraction decision, and for finding decisions recorded before
   * the action was stored in its own column. This is the field that
   * distinguishes a resolution from a dismissal; a client never has to infer it
   * from a finding's present status, which may have changed since.
   */
  findingAction: findingReviewActionSchema.nullable(),
  extractedValue: z.string().nullable(),
  proposedValue: z.string().nullable(),
  note: z.string().nullable(),
  createdAt: isoDate,
})

export const reviewExtractionBodySchema = z.object({
  outcome: z.enum(['verified', 'correction', 'needs_review']),
  correctedValue: z.string().trim().max(500).nullable().optional(),
  note: z.string().trim().max(1_000).nullable().optional(),
  version: z.number().int().min(1),
})

export const reviewFindingBodySchema = z.object({
  action: findingReviewActionSchema,
  reason: z.string().trim().max(1_000).nullable().optional(),
  version: z.number().int().min(1),
})

export const reviewQueueQuerySchema = paginationQuery.extend({
  parcelId: z.uuid().optional(),
  severity: findingSeveritySchema.optional(),
  extractionStatus: extractionReviewStatusSchema.optional(),
})

export const reviewQueueSchema = z.object({
  pendingExtractions: z.array(extractionSchema),
  openFindings: z.array(findingSchema),
  totals: z.object({
    pendingExtractions: z.number().int(),
    openFindings: z.number().int(),
  }),
})

/* -------------------------------------------------------------------------- */
/* Reconciliation and readiness                                                */
/* -------------------------------------------------------------------------- */

export const checklistOutcomeSchema = z.enum(checklistOutcomeEnum.enumValues)
export const readinessOutcomeSchema = z.enum(readinessOutcomeEnum.enumValues)

export const ruleResultSchema = z.object({
  ruleCode: z.string(),
  severity: findingSeveritySchema,
  outcome: z.union([
    checklistOutcomeSchema,
    z.literal('fail'),
    z.literal('pass'),
  ]),
  title: z.string(),
  explanation: z.string(),
  observedValue: z.string().nullable(),
  expectedValue: z.string().nullable(),
  evidenceReference: z.string().nullable(),
  recordReferences: z.array(recordReferenceSchema),
  findingKind: findingKindSchema.nullable(),
})

export const reconciliationResultSchema = z.object({
  parcelId: z.uuid(),
  rulesVersion: z.string(),
  rules: z.array(ruleResultSchema),
  summary: z.object({
    outcome: readinessOutcomeSchema,
    counts: z.record(z.string(), z.number()),
    summary: z.string(),
  }),
  raisedFindings: z.array(
    z.object({ id: z.uuid(), ruleCode: z.string(), title: z.string() }),
  ),
  existingOpenRules: z.array(z.string()),
})

export const checklistItemSchema = z.object({
  id: z.uuid(),
  ruleCode: z.string(),
  outcome: checklistOutcomeSchema,
  severity: findingSeveritySchema,
  title: z.string(),
  explanation: z.string(),
  observedValue: z.string().nullable(),
  expectedValue: z.string().nullable(),
  evidenceReference: z.string().nullable(),
  recordReferences: z.array(recordReferenceSchema),
  sortOrder: z.number().int(),
})

export const readinessReportSchema = z.object({
  id: z.uuid(),
  parcelId: z.uuid(),
  requestedBy: z.uuid().nullable(),
  outcome: readinessOutcomeSchema,
  rulesVersion: z.string(),
  summary: z.string(),
  counts: z.record(z.string(), z.number()).nullable(),
  createdAt: isoDate,
  items: z.array(checklistItemSchema),
})

/* -------------------------------------------------------------------------- */
/* Jobs                                                                        */
/* -------------------------------------------------------------------------- */

export const jobKindSchema = z.enum(processingJobKindEnum.enumValues)
export const jobStatusSchema = z.enum(processingJobStatusEnum.enumValues)

export const jobSchema = z.object({
  id: z.uuid(),
  kind: jobKindSchema,
  status: jobStatusSchema,
  parcelId: z.uuid().nullable(),
  sourceDocumentId: z.uuid().nullable(),
  requestedBy: z.uuid().nullable(),
  idempotencyKey: z.string().nullable(),
  attemptCount: z.number().int(),
  maxAttempts: z.number().int(),
  availableAt: isoDate,
  leasedUntil: isoDate.nullable(),
  lockedBy: z.string().nullable(),
  lastError: z.string().nullable(),
  payload: z.record(z.string(), z.unknown()).nullable(),
  result: z.record(z.string(), z.unknown()).nullable(),
  startedAt: isoDate.nullable(),
  finishedAt: isoDate.nullable(),
  createdAt: isoDate,
  updatedAt: isoDate,
})

/**
 * Job payloads are restricted to non-sensitive inputs by schema.
 *
 * A free-form payload would let a caller attach document text or a credential
 * to an operational record. Only the keys each job kind actually needs are
 * accepted, and anything else is rejected rather than stored.
 */
export const enqueueJobBodySchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('document_extraction'),
    parcelId: z.uuid(),
    sourceDocumentId: z.uuid(),
    fields: z.array(extractionFieldSchema).min(1).max(16).optional(),
    idempotencyKey: z.string().trim().min(8).max(200).optional(),
  }),
  z.object({
    kind: z.literal('parcel_reconciliation'),
    parcelId: z.uuid(),
    idempotencyKey: z.string().trim().min(8).max(200).optional(),
  }),
  z.object({
    kind: z.literal('readiness_report'),
    parcelId: z.uuid(),
    idempotencyKey: z.string().trim().min(8).max(200).optional(),
  }),
])

export const jobListQuerySchema = paginationQuery.extend({
  status: jobStatusSchema.optional(),
  kind: jobKindSchema.optional(),
})

/* -------------------------------------------------------------------------- */
/* Applications                                                                */
/* -------------------------------------------------------------------------- */

export const applicationTypeSchema = z.enum(applicationTypeEnum.enumValues)
export const applicationStatusSchema = z.enum(applicationStatusEnum.enumValues)

/**
 * The checklist codes an applicant may declare.
 *
 * Kept in step with the applicant-facing prototype's per-type checklist. A code
 * that is not in this set is rejected rather than stored, so the column stays a
 * meaningful vocabulary instead of free text.
 */
export const declarableDocumentCodeSchema = z.enum([
  'deed',
  'id',
  'khatian',
  'tax',
  'heir',
])

/** A share as a fraction such as `"1/3"`, or a whole number such as `"2"`. */
const shareString = z
  .string()
  .trim()
  .regex(/^\d+(\s*\/\s*\d+)?$/, 'must be a fraction such as "1/3"')

export const applicationSchema = z.object({
  id: z.uuid(),
  ownerId: z.uuid(),
  /** Null while the application is still a draft. */
  trackingNumber: z.string().nullable(),
  type: applicationTypeSchema,
  status: applicationStatusSchema,
  district: z.string(),
  upazila: z.string(),
  mouza: z.string(),
  khatianNumber: z.string(),
  dagNumber: z.string(),
  /** Exact decimal string, or null when none was recorded. Never a float. */
  areaDecimal: z.string().nullable(),
  /** Exact share as `"n/d"`, or null. */
  share: z.string().nullable(),
  parcelId: z.uuid().nullable(),
  /** Declared checklist codes: what the applicant says they are supplying. */
  declaredDocuments: z.array(z.string()),
  submittedAt: isoDate.nullable(),
  decidedAt: isoDate.nullable(),
  decisionNote: z.string().nullable(),
  nextStep: z.string().nullable(),
  deadline: isoDate.nullable(),
  origin: dataOriginSchema,
  version: z.number().int(),
  createdAt: isoDate,
  updatedAt: isoDate,
})

export const applicationTimelineEventSchema = z.object({
  date: isoDate,
  title: z.string(),
  note: z.string().optional(),
})

/**
 * An application with its derived detail.
 *
 * `timeline` is read from the append-only audit trail, so it cannot be edited
 * after the fact. `today` lets a client compare a deadline without trusting its
 * own clock.
 */
export const applicationDetailSchema = applicationSchema.extend({
  today: z.string(),
  timeline: z.array(applicationTimelineEventSchema),
})

export const applicationListQuerySchema = paginationQuery.extend({
  status: applicationStatusSchema.optional(),
  type: applicationTypeSchema.optional(),
  ownerId: z.uuid().optional(),
  parcelId: z.uuid().optional(),
})

/**
 * Creating a filing.
 *
 * The field names match the applicant-facing prototype's draft, so the client
 * sends what it already collects. Nothing here sets a status: a new filing is
 * always a draft, and moving it forward is an explicit transition.
 */
export const createApplicationBodySchema = z.object({
  type: applicationTypeSchema,
  district: z.string().trim().min(1).max(120),
  upazila: z.string().trim().min(1).max(120),
  mouza: z.string().trim().min(1).max(120),
  khatianNumber: z.string().trim().min(1).max(64),
  dagNumber: z.string().trim().min(1).max(64),
  /** Omitted when the applicant does not know the area. */
  areaDecimal: decimalArea.optional(),
  /** Omitted when the applicant does not know the share. */
  share: shareString.optional(),
  /** Declared checklist codes. */
  documents: z.array(declarableDocumentCodeSchema).max(20).default([]),
  /** An existing parcel this concerns. */
  parcelId: z.uuid().optional(),
  /** Only an administrator may set this; ignored for everybody else. */
  ownerId: z.uuid().optional(),
})

export const updateApplicationBodySchema = z.object({
  /** Optimistic-concurrency token: the version the caller last read. */
  version: z.number().int().min(1),
  district: z.string().trim().min(1).max(120).optional(),
  upazila: z.string().trim().min(1).max(120).optional(),
  mouza: z.string().trim().min(1).max(120).optional(),
  khatianNumber: z.string().trim().min(1).max(64).optional(),
  dagNumber: z.string().trim().min(1).max(64).optional(),
  areaDecimal: decimalArea.nullable().optional(),
  share: shareString.nullable().optional(),
  documents: z.array(declarableDocumentCodeSchema).max(20).optional(),
  parcelId: z.uuid().nullable().optional(),
})

/**
 * Requesting a transition.
 *
 * The caller names the state it wants; whether that is allowed is decided from
 * the state the row is actually in and the caller's role, so a client cannot
 * skip a step or set a status directly.
 */
export const transitionApplicationBodySchema = z.object({
  version: z.number().int().min(1),
  toStatus: applicationStatusSchema,
  /** Recorded with a settled decision; required when rejecting. */
  note: z.string().trim().min(1).max(1000).optional(),
  /** What happens next, for the states that wait on somebody. */
  nextStep: z.string().trim().min(1).max(500).optional(),
  /** ISO 8601 date or timestamp for the requested next step. */
  deadline: z.string().trim().min(1).max(40).nullable().optional(),
})

/* -------------------------------------------------------------------------- */
/* Audit                                                                       */
/* -------------------------------------------------------------------------- */

export const auditEventSchema = z.object({
  id: z.uuid(),
  actorId: z.uuid().nullable(),
  actorRole: userRoleSchema.nullable(),
  action: z.string(),
  entityType: z.string(),
  entityId: z.string().nullable(),
  summary: z.string().nullable(),
  changes: z.record(z.string(), z.unknown()).nullable(),
  requestId: z.string().nullable(),
  createdAt: isoDate,
})

export const auditListQuerySchema = paginationQuery.extend({
  entityType: z.string().min(1).max(64).optional(),
  entityId: z.string().min(1).max(100).optional(),
  action: z.string().min(1).max(100).optional(),
  actorId: z.uuid().optional(),
})

export const healthSchema = z.object({
  status: z.string(),
  service: z.string(),
  version: z.string(),
  database: z
    .object({ ok: z.boolean(), latencyMs: z.number() })
    .optional(),
})
