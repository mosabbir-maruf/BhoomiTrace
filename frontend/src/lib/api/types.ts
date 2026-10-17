/**
 * BhoomiTrace — Frontend API & Domain Types
 * Aligned with the Fastify backend contracts (/api/v1).
 */

/* -------------------------------------------------------------------------- */
/* Common / Envelopes                                                         */
/* -------------------------------------------------------------------------- */

export interface Page<T> {
  items: T[]
  total: number
  limit: number
  offset: number
  hasMore: boolean
}

export interface ApiErrorDetail {
  code: string
  message: string
  requestId?: string
  details?: unknown
}

export interface ApiErrorResponse {
  error: ApiErrorDetail
}

export interface BoundingBox {
  x: number
  y: number
  width: number
  height: number
}

/* -------------------------------------------------------------------------- */
/* User & Session                                                             */
/* -------------------------------------------------------------------------- */

export type UserRole = "applicant" | "reviewer" | "admin"
export type UserStatus = "active" | "suspended"
export type DemoRole = "citizen" | "reviewer"

export interface PublicUser {
  id: string
  email: string
  displayName: string
  role: UserRole
  status: UserStatus
  createdAt: string
}

export interface SessionResponse {
  user: PublicUser
  csrfToken: string
  expiresAt: string
}

export interface Session {
  user?: PublicUser
  role: "citizen" | "reviewer" | "admin"
  displayName: string
  email?: string
  id?: string
  accountId: string
  isDemo?: boolean
  demo?: boolean
}

export interface LoginInput {
  email: string
  password: string
}

export interface RegisterInput {
  email: string
  displayName: string
  password: string
}

/* -------------------------------------------------------------------------- */
/* Parcels                                                                    */
/* -------------------------------------------------------------------------- */

export type RecordSurvey = "CS" | "SA" | "RS" | "BS"
export type ParcelLifecycle = "active" | "retired"
export type DataOrigin = "synthetic_demo" | "user_created"

export interface Parcel {
  id: string
  ownerId?: string | null
  origin?: DataOrigin
  lifecycle?: ParcelLifecycle
  survey: RecordSurvey
  khatianNumber: string
  mouza: string
  jlNumber: string
  upazila: string
  district: string
  areaDecimal: number
  rawAreaDecimal?: string
  shareNumerator?: number
  shareDenominator?: number
  ownershipShare: string
  dagNumbers: string[]
  version?: number
  retirementReason?: string | null
  retiredAt?: string | null
  createdAt?: string
  updatedAt?: string
}

export interface BackendParcel {
  id: string
  ownerId: string | null
  origin: DataOrigin
  lifecycle: ParcelLifecycle
  survey: RecordSurvey
  khatianNumber: string
  mouza: string
  jlNumber: string
  upazila: string
  district: string
  areaDecimal: string
  shareNumerator: number
  shareDenominator: number
  ownershipShare: string
  dagNumbers: string[]
  version: number
  retirementReason: string | null
  retiredAt: string | null
  createdAt: string
  updatedAt: string
}

export interface ParcelHistoryEntry {
  survey: RecordSurvey
  year: string
  khatianNumber: string
  dagNumbers: string[]
  certainty: "sample" | "illustrative" | "confirmed"
  note: string
}

export interface ParcelDetail extends Parcel {
  history: ParcelHistoryEntry[]
  documents: DocumentItem[]
  applications: ApplicationSummary[]
  findings?: Finding[]
  reconciliation?: ReconciliationResult
}

/* -------------------------------------------------------------------------- */
/* Lineage                                                                    */
/* -------------------------------------------------------------------------- */

export type LineageRelation = "continued" | "renumbered" | "split" | "merge"
export type LineageCertainty = "confirmed" | "illustrative" | "unverified"

export interface LineageLink {
  id: string
  fromParcelId: string
  toParcelId: string
  relation: LineageRelation
  certainty: LineageCertainty
  evidenceReference: string | null
  note: string | null
  createdAt: string
}

export interface LineageArithmeticNote {
  ruleCode: string
  relation: LineageRelation
  observedParts: string[]
  observedTotal: string
  expectedTotal: string
  exactlyEqual: boolean
  explanation: string
}

export interface LineageList {
  outgoing: LineageLink[]
  incoming: LineageLink[]
  arithmetic: LineageArithmeticNote[]
}

/* -------------------------------------------------------------------------- */
/* Documents                                                                  */
/* -------------------------------------------------------------------------- */

export type SourceDocumentKind = "synthetic_demo" | "manual_entry" | "external_reference"
export type DocumentStatus = "requested" | "in_review" | "submitted"

export interface BackendDocument {
  id: string
  ownerId: string | null
  origin: DataOrigin
  title: string
  kind: SourceDocumentKind
  reference: string | null
  pageCount: number | null
  checksumSha256: string | null
  status: DocumentStatus
  contentType: string | null
  byteSize: number | null
  originalFilename: string | null
  hasStoredFile: boolean
  version: number
  createdAt: string
  updatedAt: string
}

export interface ExtractedField {
  id: string
  label: string
  value: string
  source: string
  unclear?: boolean
}

export interface DocumentItem {
  id: string
  name: string
  applicationId: string | null
  parcelId: string | null
  status: DocumentStatus
  date: string | null
  reference: string | null
  pages: number | null
  note: string
  fields: ExtractedField[]
  hasStoredFile?: boolean
  contentType?: string | null
  byteSize?: number | null
  originalFilename?: string | null
}

/* -------------------------------------------------------------------------- */
/* Extractions                                                                */
/* -------------------------------------------------------------------------- */

export type ExtractionField = "khatian" | "mouza" | "dag" | "area" | "share" | "owner"
export type ExtractionReviewStatus = "pending" | "confirmed" | "corrected" | "unclear"

export interface Extraction {
  id: string
  parcelId: string
  sourceDocumentId: string | null
  pageId: string | null
  field: ExtractionField
  recordedValue: string
  reviewedValue: string | null
  reviewStatus: ExtractionReviewStatus
  confidence: string | null
  isUnclear: boolean
  pageReference: string | null
  boundingBox: BoundingBox | null
  provider: string | null
  providerModel: string | null
  origin: "manual_entry" | "provider"
  extractedAt: string | null
  reviewedBy: string | null
  reviewedAt: string | null
  version: number
  createdAt: string
  updatedAt: string
}

/* -------------------------------------------------------------------------- */
/* Findings & Review Decisions                                                */
/* -------------------------------------------------------------------------- */

export type FindingKind = "area_mismatch" | "share_mismatch" | "dag_mismatch" | "khatian_mismatch" | "mouza_mismatch" | "lineage_break" | "unclear_reading" | "other" | "area_discrepancy" | "unclear_folio" | "ownership_gap" | "document_required"

export type FindingSeverity = "info" | "low" | "medium" | "high" | "critical"
export type FindingStatus = "open" | "under_review" | "resolved" | "dismissed"
export type FindingReviewAction = "under_review" | "resolved" | "dismissed"
export type ReviewOutcome = "verified" | "correction" | "needs_review" | "dismissed"

export interface Finding {
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

export interface ReviewDecision {
  id: string
  findingId: string | null
  extractionId: string | null
  reviewerId: string
  outcome: ReviewOutcome
  findingAction: FindingReviewAction | null
  extractedValue: string | null
  proposedValue: string | null
  note: string | null
  createdAt: string
}

export interface ReviewFindingInput {
  findingId: string
  action: FindingReviewAction
  reason?: string
  version: number
}

export interface ReviewFindingResult {
  finding: Finding
  decision: ReviewDecision
}

export interface ReviewOutcomeInput {
  caseId: string
  fieldId: string
  outcome: ReviewOutcome
  extractedValue: string
  proposedValue?: string
  note?: string
  version?: number
}

export interface ReviewOutcomeResult extends ReviewOutcomeInput {
  recordedAt: string
  demo?: boolean
}

export interface ReviewQueue {
  pendingExtractions: Extraction[]
  openFindings: Finding[]
  totals: {
    pendingExtractions: number
    openFindings: number
  }
}

export type CaseStatus = "new" | "in_progress" | "needs_info"

export interface ReviewCaseSummary {
  id: string
  reference: string
  title: string
  summary: string
  status: CaseStatus
  receivedAt: string
  nextAction: string
  parcelId?: string
}

/* -------------------------------------------------------------------------- */
/* Reconciliation & Readiness                                                 */
/* -------------------------------------------------------------------------- */

export type ChecklistOutcome = "pass" | "fail" | "needs_review" | "not_applicable"
export type ReadinessOutcome = "ready_for_review" | "needs_review" | "not_ready" | "ready" | "blocked"

export interface RuleResult {
  ruleCode: string
  title: string
  explanation: string
  severity: FindingSeverity
  outcome: ChecklistOutcome | "pass" | "fail"
  observedValue?: string | null
  expectedValue?: string | null
  evidenceReference?: string | null
  findingKind?: FindingKind | null
}

export interface ReconciliationResult {
  parcelId: string
  rulesVersion: string
  rules: RuleResult[]
  summary: {
    outcome: ReadinessOutcome
    summary: string
    counts: Record<string, number>
  }
  raisedFindings?: Array<{ id: string; ruleCode: string; title: string }>
  existingOpenRules?: string[]
}

/* -------------------------------------------------------------------------- */
/* Applications                                                               */
/* -------------------------------------------------------------------------- */

export type ApplicationType = "mutation" | "record_correction" | "certified_copy"
export type ApplicationStatus = "draft" | "submitted" | "under_review" | "documents_required" | "hearing_scheduled" | "approved" | "rejected"

export interface BackendApplication {
  id: string
  ownerId: string
  trackingNumber: string | null
  type: ApplicationType
  status: ApplicationStatus
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
  origin: DataOrigin
  version: number
  createdAt: string
  updatedAt: string
}

export interface ApplicationSummary {
  id: string
  trackingNumber: string | null
  type: ApplicationType
  district: string
  upazila: string
  mouza: string
  khatianNumber: string
  dagNumber: string
  parcelId: string | null
  submittedAt: string | null
  updatedAt: string
  status: ApplicationStatus
  nextStep: string | null
  deadline: string | null
  version?: number
}

export interface TimelineEvent {
  date: string
  title: string
  note?: string
}

export interface BackendApplicationDetail extends BackendApplication {
  today: string
  timeline: TimelineEvent[]
}

export interface ApplicationDetail extends ApplicationSummary {
  today: string
  timeline: TimelineEvent[]
  decisionNote: string | null
  documents: DocumentItem[]
  parcel: Parcel | null
}

export interface NewApplicationDraft {
  type: ApplicationType
  district: string
  upazila: string
  mouza: string
  khatianNumber: string
  dagNumber: string
  areaDecimal: string
  share: string
  documents: string[]
  parcelId?: string
}

export interface NewApplicationResult {
  referenceId: string
  demo: boolean
  applicationId?: string
  trackingNumber?: string | null
}

export interface CertifiedCopyRequestResult {
  requestId: string
  parcelId: string
}

/* -------------------------------------------------------------------------- */
/* Dashboard & Action Items                                                   */
/* -------------------------------------------------------------------------- */

export type ActionItemKind = "document" | "hearing"

export interface ActionItem {
  id: string
  kind: ActionItemKind
  title: string
  detail: string
  dueDate: string
  applicationId: string
}

export interface ApplicantProfile {
  id: string
  name: string
  accountId: string
  role: "applicant" | "reviewer"
}

export interface ApplicantDashboard {
  today: string
  applicant: ApplicantProfile
  applications: ApplicationSummary[]
  parcels: Parcel[]
  actionItems: ActionItem[]
  documents: DocumentItem[]
}
