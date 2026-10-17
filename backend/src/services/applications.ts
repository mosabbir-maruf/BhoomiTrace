import { and, asc, desc, eq, sql } from 'drizzle-orm'

import type { Database } from '../db/client.js'
import { applications, type Application } from '../db/schema/applications.js'
import type {
  ApplicationStatus,
  ApplicationType,
  DataOrigin,
  UserRole,
} from '../db/schema/enums.js'
import { auditEvents, type AuditEvent } from '../db/schema/audit.js'
import { users, type User } from '../db/schema/users.js'
import {
  BadRequestError,
  ConcurrencyError,
  ForbiddenError,
  InvalidTransitionError,
  NotFoundError,
} from '../lib/errors.js'
import type { Page, PaginationQuery } from '../lib/pagination.js'
import { pageOf } from '../lib/pagination.js'
import {
  formatArea,
  formatShare,
  NumericFormatError,
  parseArea,
  parseShare,
} from '../lib/rational.js'
import { AuditActions, recordAuditEvent } from './audit.js'
import { loadVisibleParcel } from './parcels.js'

/**
 * Applications: a tracked filing, and the states it moves through.
 *
 * ## What this module does and does not decide
 *
 * It records that an application was filed, keeps a validated history of its
 * state, and lets the right people move it forward. It does **not** determine
 * any right in land and does not represent a government decision. `approved`,
 * `rejected`, and the rest are states in this tracker; the platform never claims
 * that reaching one of them settles anything outside it. The README records the
 * product decisions that must be made before any of these states could be
 * presented as an official outcome.
 *
 * ## The three rules that keep it honest
 *
 * 1. **Transitions are an explicit table, not a free-form status write.** A
 *    client cannot set a status; it may only request a transition that the table
 *    allows from the state the row is actually in. Anything else is a `409`, so
 *    history cannot be skipped or invented.
 * 2. **A filing belongs to its applicant.** An applicant sees and edits only
 *    their own, and only while it is still a draft. Reviewers see every filing
 *    but can never rewrite one — changing a filing is the applicant's act, and a
 *    reviewer's is to decide.
 * 3. **Every change is version-aware and audited.** A writer states the version
 *    it read; a mismatch is a `409` rather than a silent overwrite. Each change
 *    and its audit entry share one transaction and name the actor.
 *
 * ## Exact values
 *
 * Areas and shares are parsed and stored exactly, never as floats, exactly as on
 * parcels. A value the platform cannot represent exactly is rejected rather than
 * rounded.
 */

export interface ApplicationView {
  id: string
  ownerId: string
  /** Assigned at submission; `null` while the application is a draft. */
  trackingNumber: string | null
  type: ApplicationType
  status: ApplicationStatus
  district: string
  upazila: string
  mouza: string
  khatianNumber: string
  dagNumber: string
  /** Exact area as a decimal string, or `null` when none was recorded. */
  areaDecimal: string | null
  /** Exact share as `"n/d"`, or `null` when none was recorded. */
  share: string | null
  parcelId: string | null
  /** Declared checklist codes — what the applicant says they are supplying. */
  declaredDocuments: string[]
  submittedAt: string | null
  decidedAt: string | null
  /** Recorded only when the application reached a settled state. */
  decisionNote: string | null
  nextStep: string | null
  deadline: string | null
  origin: DataOrigin
  version: number
  createdAt: string
  updatedAt: string
}

/** One dated entry in an application's history, derived from its audit trail. */
export interface ApplicationTimelineEvent {
  date: string
  title: string
  note?: string
}

export interface ApplicationDetailView extends ApplicationView {
  /** The server's current date, so a client can compare against a deadline. */
  today: string
  timeline: ApplicationTimelineEvent[]
}

/**
 * The checklist codes an applicant may declare.
 *
 * These are the codes the applicant-facing prototype's checklist uses for each
 * application type. Validating against a fixed set keeps the column meaningful
 * instead of accepting arbitrary text; adding a code is a deliberate change in
 * one place, as the frontend contract changes with it.
 */
export const DECLARABLE_DOCUMENT_CODES = [
  'deed',
  'id',
  'khatian',
  'tax',
  'heir',
] as const

function toApplicationView(row: Application): ApplicationView {
  const share =
    row.shareNumerator === null || row.shareDenominator === null
      ? null
      : formatShare({ numerator: BigInt(row.shareNumerator), denominator: BigInt(row.shareDenominator) })

  return {
    id: row.id,
    ownerId: row.ownerId,
    trackingNumber: row.trackingNumber,
    type: row.type,
    status: row.status,
    district: row.district,
    upazila: row.upazila,
    mouza: row.mouza,
    khatianNumber: row.khatianNumber,
    dagNumber: row.dagNumber,
    areaDecimal: row.areaDecimal,
    share,
    parcelId: row.parcelId,
    declaredDocuments: readDeclaredDocuments(row.declaredDocuments),
    submittedAt: row.submittedAt?.toISOString() ?? null,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    decisionNote: row.decisionNote,
    nextStep: row.nextStep,
    deadline: row.deadline?.toISOString() ?? null,
    origin: row.origin,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

/** Reads the declared codes defensively: a non-array value reads as none. */
function readDeclaredDocuments(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string')
}

/* -------------------------------------------------------------------------- */
/* Visibility                                                                  */
/* -------------------------------------------------------------------------- */

/** Reviewers and administrators see every filing; an applicant sees their own. */
function canSeeEveryApplication(user: User): boolean {
  return user.role === 'reviewer' || user.role === 'admin'
}

function visibilityFilter(user: User) {
  return canSeeEveryApplication(user) ? undefined : eq(applications.ownerId, user.id)
}

/* -------------------------------------------------------------------------- */
/* Reading                                                                     */
/* -------------------------------------------------------------------------- */

export interface ApplicationFilters {
  status?: ApplicationStatus
  type?: ApplicationType
  ownerId?: string
  parcelId?: string
}

export interface ListApplicationsInput {
  user: User
  filters?: ApplicationFilters
  pagination: PaginationQuery
}

export async function listApplications(
  database: Database,
  input: ListApplicationsInput,
): Promise<Page<ApplicationView>> {
  const filters = input.filters ?? {}

  const where = and(
    visibilityFilter(input.user),
    filters.status === undefined ? undefined : eq(applications.status, filters.status),
    filters.type === undefined ? undefined : eq(applications.type, filters.type),
    filters.ownerId === undefined ? undefined : eq(applications.ownerId, filters.ownerId),
    filters.parcelId === undefined ? undefined : eq(applications.parcelId, filters.parcelId),
  )

  const [rows, counted] = await Promise.all([
    database.orm
      .select()
      .from(applications)
      .where(where)
      .orderBy(desc(applications.createdAt), desc(applications.id))
      .limit(input.pagination.limit)
      .offset(input.pagination.offset),
    database.orm
      .select({ count: sql<number>`count(*)::int` })
      .from(applications)
      .where(where),
  ])

  return pageOf(rows.map(toApplicationView), counted[0]?.count ?? 0, input.pagination)
}

/**
 * Loads a filing the caller is allowed to see.
 *
 * A filing the caller may not see is reported exactly like one that does not
 * exist, so an identifier cannot be used to discover other people's filings.
 */
export async function loadVisibleApplication(
  database: Database,
  user: User,
  applicationId: string,
): Promise<Application> {
  const rows = await database.orm
    .select()
    .from(applications)
    .where(
      and(
        eq(applications.id, applicationId),
        visibilityFilter(user),
      ),
    )
    .limit(1)

  const application = rows[0]
  if (application === undefined) {
    throw new NotFoundError('No application exists with that identifier.')
  }

  return application
}

/** Loads a filing plus its derived detail: the history and today's date. */
export async function loadVisibleApplicationDetail(
  database: Database,
  user: User,
  applicationId: string,
): Promise<ApplicationDetailView> {
  const application = await loadVisibleApplication(database, user, applicationId)
  const timeline = await loadApplicationTimeline(database, application.id)

  return {
    ...toApplicationView(application),
    today: new Date().toISOString().slice(0, 10),
    timeline,
  }
}

/**
 * Builds the timeline from the audit trail.
 *
 * The events are the history: nothing else records the order of what happened,
 * and because the audit table is append-only the timeline cannot be edited after
 * the fact. Titles are factual and in English; a client owns its own wording,
 * and the backend does not invent localised copy that would look official.
 */
export async function loadApplicationTimeline(
  database: Database,
  applicationId: string,
): Promise<ApplicationTimelineEvent[]> {
  const rows = await database.orm
    .select()
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.entityType, 'application'),
        eq(auditEvents.entityId, applicationId),
      ),
    )
    .orderBy(asc(auditEvents.createdAt), asc(auditEvents.id))

  return rows.map(toTimelineEvent)
}

function toTimelineEvent(event: AuditEvent): ApplicationTimelineEvent {
  const changes = (event.changes ?? {}) as Record<string, unknown>

  let title: string
  switch (event.action) {
    case AuditActions.applicationCreated:
      title = 'Application created'
      break
    case AuditActions.applicationUpdated:
      title = 'Application details updated'
      break
    case AuditActions.applicationStatusChanged: {
      const from = typeof changes.from === 'string' ? changes.from : 'unknown'
      const to = typeof changes.to === 'string' ? changes.to : 'unknown'
      title = `Status: ${from} → ${to}`
      break
    }
    default:
      title = event.action
  }

  const note = event.summary

  return {
    date: event.createdAt.toISOString(),
    title,
    ...(note === null ? {} : { note }),
  }
}

/* -------------------------------------------------------------------------- */
/* Exact-value parsing                                                         */
/* -------------------------------------------------------------------------- */

/** Converts a rational-format failure into the API's validation error. */
function parseAreaValue(value: string): string {
  try {
    return formatArea(parseArea(value))
  } catch (error) {
    if (error instanceof NumericFormatError) {
      throw new BadRequestError(
        'The recorded area must be a decimal number with at most four decimal places.',
        { field: 'areaDecimal' },
      )
    }
    throw error
  }
}

function parseShareValue(value: string): { numerator: number; denominator: number } {
  try {
    const share = parseShare(value)
    return {
      numerator: Number(share.numerator),
      denominator: Number(share.denominator),
    }
  } catch (error) {
    if (error instanceof NumericFormatError) {
      throw new BadRequestError(
        'The ownership share must be a fraction such as "1/3".',
        { field: 'share' },
      )
    }
    throw error
  }
}

function parseDeclaredDocuments(codes: readonly string[]): string[] {
  const allowed = new Set<string>(DECLARABLE_DOCUMENT_CODES)
  const unique = [...new Set(codes.map((code) => code.trim()))].filter(
    (code) => code.length > 0,
  )

  const unknown = unique.filter((code) => !allowed.has(code))
  if (unknown.length > 0) {
    throw new BadRequestError(
      `Unknown document checklist code(s): ${unknown.join(', ')}.`,
      { field: 'documents', allowed: [...DECLARABLE_DOCUMENT_CODES] },
    )
  }

  return unique
}

function parseDeadline(value: string | null | undefined): Date | null {
  if (value === null || value === undefined) return null

  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    throw new BadRequestError('The deadline must be an ISO 8601 date or timestamp.', {
      field: 'deadline',
    })
  }

  return parsed
}

/* -------------------------------------------------------------------------- */
/* Creating                                                                    */
/* -------------------------------------------------------------------------- */

export interface CreateApplicationInput {
  user: User
  type: ApplicationType
  district: string
  upazila: string
  mouza: string
  khatianNumber: string
  dagNumber: string
  /** Exact area as a decimal string; omitted when unknown. */
  areaDecimal?: string
  /** Exact share as `"n/d"`; omitted when unknown. */
  share?: string
  /** Declared checklist codes. */
  declaredDocuments?: readonly string[]
  /** An existing parcel this concerns, when the client names one. */
  parcelId?: string
  /** Administrators only: file on behalf of another account. */
  ownerId?: string
  requestId?: string | null
}

/** Loads the account a filing will belong to, so visibility is checked on it. */
async function loadAccount(database: Database, userId: string): Promise<User> {
  const rows = await database.orm
    .select()
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)

  const user = rows[0]
  if (user === undefined) {
    throw new NotFoundError('No account exists with that identifier.')
  }

  return user
}

export async function createApplication(
  database: Database,
  input: CreateApplicationInput,
): Promise<ApplicationView> {
  // A reviewer's business is to check filings, not to write them. An
  // administrator may file on somebody's behalf, which is the one case where an
  // explicit `ownerId` is honoured.
  if (input.user.role === 'reviewer') {
    throw new ForbiddenError(
      'Reviewers do not create filings. Review an existing application instead.',
    )
  }

  const ownerId =
    input.user.role === 'admin' ? (input.ownerId ?? input.user.id) : input.user.id

  const owner = ownerId === input.user.id ? input.user : await loadAccount(database, ownerId)

  const areaDecimal =
    input.areaDecimal === undefined || input.areaDecimal.trim().length === 0
      ? null
      : parseAreaValue(input.areaDecimal)

  const shareValue =
    input.share === undefined || input.share.trim().length === 0
      ? null
      : parseShareValue(input.share)

  const declaredDocuments = parseDeclaredDocuments(input.declaredDocuments ?? [])

  // A link to a parcel is only meaningful if the filing's owner can read that
  // parcel: otherwise the applicant would have a filing pointing at a record
  // they are not allowed to see. Visibility is therefore checked as the owner,
  // not as whichever account happens to be acting.
  if (input.parcelId !== undefined) {
    await loadVisibleParcel(database, owner, input.parcelId)
  }

  return database.orm.transaction(async (tx) => {
    const inserted = await tx
      .insert(applications)
      .values({
        ownerId,
        origin: 'user_created',
        type: input.type,
        status: 'draft',
        district: input.district.trim(),
        upazila: input.upazila.trim(),
        mouza: input.mouza.trim(),
        khatianNumber: input.khatianNumber.trim(),
        dagNumber: input.dagNumber.trim(),
        areaDecimal,
        shareNumerator: shareValue?.numerator ?? null,
        shareDenominator: shareValue?.denominator ?? null,
        parcelId: input.parcelId ?? null,
        declaredDocuments,
      })
      .returning()

    const application = inserted[0]
    if (application === undefined) {
      throw new Error('Application insert did not return the created row.')
    }

    await recordAuditEvent(tx, {
      actor: { kind: 'user', userId: input.user.id, role: input.user.role },
      action: AuditActions.applicationCreated,
      entityType: 'application',
      entityId: application.id,
      summary: 'Application recorded as a draft.',
      changes: {
        type: application.type,
        status: application.status,
        ownerId: application.ownerId,
        mouza: application.mouza,
        khatianNumber: application.khatianNumber,
        dagNumber: application.dagNumber,
        areaDecimal: application.areaDecimal,
        declaredDocuments: application.declaredDocuments,
      },
      requestId: input.requestId ?? null,
    })

    return toApplicationView(application)
  })
}

/* -------------------------------------------------------------------------- */
/* Updating                                                                    */
/* -------------------------------------------------------------------------- */

export interface UpdateApplicationInput {
  user: User
  applicationId: string
  /** The version the caller last read. */
  version: number
  district?: string
  upazila?: string
  mouza?: string
  khatianNumber?: string
  dagNumber?: string
  /** `null` clears a previously recorded area. */
  areaDecimal?: string | null
  /** `null` clears a previously recorded share. */
  share?: string | null
  declaredDocuments?: readonly string[]
  /** `null` unlinks the parcel. */
  parcelId?: string | null
  requestId?: string | null
}

export async function updateApplication(
  database: Database,
  input: UpdateApplicationInput,
): Promise<ApplicationView> {
  const existing = await loadVisibleApplication(database, input.user, input.applicationId)

  // A filing is the applicant's own statement. A reviewer decides about a
  // filing; rewriting its contents would erase the applicant's account of it.
  if (input.user.role === 'reviewer') {
    throw new ForbiddenError(
      'A reviewer does not rewrite a filing. Record a decision instead.',
    )
  }

  if (input.user.role === 'applicant' && existing.ownerId !== input.user.id) {
    throw new NotFoundError('No application exists with that identifier.')
  }

  // Once a filing has been submitted its contents are part of the record and no
  // longer the applicant's alone to edit. Only an administrator may correct one,
  // and the change is audited either way.
  if (existing.status !== 'draft' && input.user.role !== 'admin') {
    throw new ForbiddenError(
      'A submitted application can no longer be edited. Request a correction or file a new application.',
    )
  }

  if (input.parcelId !== undefined && input.parcelId !== null) {
    const owner = await loadAccount(database, existing.ownerId)
    await loadVisibleParcel(database, owner, input.parcelId)
  }

  const areaDecimal =
    input.areaDecimal === undefined
      ? undefined
      : input.areaDecimal === null || input.areaDecimal.trim().length === 0
        ? null
        : parseAreaValue(input.areaDecimal)

  const shareValue =
    input.share === undefined
      ? undefined
      : input.share === null || input.share.trim().length === 0
        ? null
        : parseShareValue(input.share)

  const declaredDocuments =
    input.declaredDocuments === undefined
      ? undefined
      : parseDeclaredDocuments(input.declaredDocuments)

  return database.orm.transaction(async (tx) => {
    // The guard is on the version the caller read, so a concurrent change is a
    // conflict rather than a silent overwrite.
    const updated = await tx
      .update(applications)
      .set({
        ...(input.district === undefined ? {} : { district: input.district.trim() }),
        ...(input.upazila === undefined ? {} : { upazila: input.upazila.trim() }),
        ...(input.mouza === undefined ? {} : { mouza: input.mouza.trim() }),
        ...(input.khatianNumber === undefined
          ? {}
          : { khatianNumber: input.khatianNumber.trim() }),
        ...(input.dagNumber === undefined ? {} : { dagNumber: input.dagNumber.trim() }),
        ...(areaDecimal === undefined ? {} : { areaDecimal }),
        ...(shareValue === undefined
          ? {}
          : {
              shareNumerator: shareValue?.numerator ?? null,
              shareDenominator: shareValue?.denominator ?? null,
            }),
        ...(declaredDocuments === undefined ? {} : { declaredDocuments }),
        ...(input.parcelId === undefined ? {} : { parcelId: input.parcelId }),
        updatedAt: new Date(),
      })
      .where(
        and(eq(applications.id, input.applicationId), eq(applications.version, input.version)),
      )
      .returning()

    const application = updated[0]
    if (application === undefined) {
      throw new ConcurrencyError(
        'This application changed since you read it. Reload it and try again.',
      )
    }

    await recordAuditEvent(tx, {
      actor: { kind: 'user', userId: input.user.id, role: input.user.role },
      action: AuditActions.applicationUpdated,
      entityType: 'application',
      entityId: application.id,
      summary: 'Application details updated.',
      changes: {
        previous: {
          district: existing.district,
          upazila: existing.upazila,
          mouza: existing.mouza,
          khatianNumber: existing.khatianNumber,
          dagNumber: existing.dagNumber,
          areaDecimal: existing.areaDecimal,
          parcelId: existing.parcelId,
        },
        next: {
          district: application.district,
          upazila: application.upazila,
          mouza: application.mouza,
          khatianNumber: application.khatianNumber,
          dagNumber: application.dagNumber,
          areaDecimal: application.areaDecimal,
          parcelId: application.parcelId,
        },
        version: application.version,
      },
      requestId: input.requestId ?? null,
    })

    return toApplicationView(application)
  })
}

/* -------------------------------------------------------------------------- */
/* Transitions                                                                 */
/* -------------------------------------------------------------------------- */

/** Who may perform a transition, expressed as roles. */
type TransitionActor = UserRole

interface TransitionRule {
  from: ApplicationStatus
  to: ApplicationStatus
  /** Roles permitted to request this transition. */
  actors: readonly TransitionActor[]
}

/**
 * The whole workflow, in one table.
 *
 * Reading it top to bottom is the specification: a filing is drafted, then
 * submitted; a reviewer takes it under review and may ask for documents or
 * schedule a hearing; either way it settles as approved or rejected. A settled
 * application has no outgoing transition, so it cannot be reopened — a
 * correction is a new filing, which keeps the history of what was decided.
 *
 * `owner` is expressed as the `applicant` role: an applicant may submit their
 * own draft and respond to a request for documents, but may not drive a review.
 * An administrator may act at every step, because that is the role the platform
 * reserves for operating on someone's behalf; a reviewer may only decide.
 */
const TRANSITIONS: readonly TransitionRule[] = [
  { from: 'draft', to: 'submitted', actors: ['applicant', 'admin'] },
  { from: 'submitted', to: 'under_review', actors: ['reviewer', 'admin'] },
  { from: 'under_review', to: 'documents_required', actors: ['reviewer', 'admin'] },
  { from: 'documents_required', to: 'under_review', actors: ['applicant', 'reviewer', 'admin'] },
  { from: 'under_review', to: 'hearing_scheduled', actors: ['reviewer', 'admin'] },
  { from: 'hearing_scheduled', to: 'under_review', actors: ['reviewer', 'admin'] },
  { from: 'under_review', to: 'approved', actors: ['reviewer', 'admin'] },
  { from: 'under_review', to: 'rejected', actors: ['reviewer', 'admin'] },
  { from: 'hearing_scheduled', to: 'approved', actors: ['reviewer', 'admin'] },
  { from: 'hearing_scheduled', to: 'rejected', actors: ['reviewer', 'admin'] },
]

/** The states that settle an application. Both are terminal. */
const SETTLED_STATUSES: readonly ApplicationStatus[] = ['approved', 'rejected']

const TERMINAL_STATUSES: readonly ApplicationStatus[] = SETTLED_STATUSES

function findTransition(
  from: ApplicationStatus,
  to: ApplicationStatus,
): TransitionRule | undefined {
  return TRANSITIONS.find((rule) => rule.from === from && rule.to === to)
}

/** Describes what is possible from a state, for an error message. */
function allowedTargets(from: ApplicationStatus): string[] {
  return TRANSITIONS.filter((rule) => rule.from === from).map((rule) => rule.to)
}

export interface TransitionApplicationInput {
  user: User
  applicationId: string
  /** The version the caller last read. */
  version: number
  toStatus: ApplicationStatus
  /** Recorded with a settled decision; required when rejecting. */
  note?: string
  /** What happens next, for the states that wait on somebody. */
  nextStep?: string
  /** ISO 8601 date or timestamp for a requested next step. */
  deadline?: string | null
  requestId?: string | null
}

export async function transitionApplication(
  database: Database,
  input: TransitionApplicationInput,
): Promise<ApplicationView> {
  const existing = await loadVisibleApplication(database, input.user, input.applicationId)

  // Ownership first, then the workflow: an applicant may only move their own
  // filing, and a role that is not in the rule for this step may not move it at
  // all.
  if (input.user.role === 'applicant' && existing.ownerId !== input.user.id) {
    throw new NotFoundError('No application exists with that identifier.')
  }

  if (TERMINAL_STATUSES.includes(existing.status)) {
    throw new InvalidTransitionError(
      `This application is ${existing.status} and cannot be moved again. File a new application to change the record.`,
      { status: existing.status },
    )
  }

  const rule = findTransition(existing.status, input.toStatus)
  if (rule === undefined) {
    throw new InvalidTransitionError(
      `An application in state "${existing.status}" cannot move to "${input.toStatus}". Possible next states: ${
        allowedTargets(existing.status).join(', ') || 'none'
      }.`,
      { from: existing.status, requested: input.toStatus },
    )
  }

  if (!rule.actors.includes(input.user.role)) {
    throw new ForbiddenError(
      `Your role is not permitted to move an application from "${rule.from}" to "${rule.to}".`,
    )
  }

  const note = input.note?.trim() ?? ''
  if (input.toStatus === 'rejected' && note.length === 0) {
    throw new BadRequestError(
      'A reason is required when an application is rejected.',
      { field: 'note' },
    )
  }

  const nextStep =
    input.toStatus === 'documents_required' || input.toStatus === 'hearing_scheduled'
      ? (input.nextStep?.trim() ?? null)
      : null
  const deadline =
    input.toStatus === 'documents_required' || input.toStatus === 'hearing_scheduled'
      ? parseDeadline(input.deadline)
      : null

  return database.orm.transaction(async (tx) => {
    // The guarded update repeats both the version and the state it expects, so
    // two people racing to move the same filing cannot both succeed and a
    // transition can never be applied twice.
    const updated = await tx
      .update(applications)
      .set({
        status: input.toStatus,
        ...(input.toStatus === 'submitted'
          ? { trackingNumber: await nextTrackingNumber(tx), submittedAt: new Date() }
          : {}),
        ...(SETTLED_STATUSES.includes(input.toStatus)
          ? { decidedAt: new Date(), decisionNote: note.length > 0 ? note : null }
          : {}),
        nextStep,
        deadline,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(applications.id, input.applicationId),
          eq(applications.version, input.version),
          eq(applications.status, existing.status),
        ),
      )
      .returning()

    const application = updated[0]
    if (application === undefined) {
      throw new ConcurrencyError(
        'This application changed while you were acting on it. Reload it and try again.',
      )
    }

    await recordAuditEvent(tx, {
      actor: { kind: 'user', userId: input.user.id, role: input.user.role },
      action: AuditActions.applicationStatusChanged,
      entityType: 'application',
      entityId: application.id,
      summary:
        note.length > 0
          ? `Moved from ${existing.status} to ${application.status}: ${note}`
          : `Moved from ${existing.status} to ${application.status}.`,
      changes: {
        from: existing.status,
        to: application.status,
        trackingNumber: application.trackingNumber,
        nextStep: application.nextStep,
        deadline: application.deadline,
        ...(note.length > 0 ? { note } : {}),
      },
      requestId: input.requestId ?? null,
    })

    return toApplicationView(application)
  })
}

/**
 * Draws the next tracking number from the sequence.
 *
 * `BT-<year>-<serial>`, where the serial is drawn atomically from a database
 * sequence so two simultaneous submissions cannot collide. Runs inside the
 * caller's transaction.
 */
async function nextTrackingNumber(executor: {
  execute: Database['orm']['execute']
}): Promise<string> {
  const result = await executor.execute(
    sql`select nextval('applications_tracking_number_seq') as serial`,
  )

  const row = (result.rows[0] ?? {}) as { serial?: string | number }
  const serial = Number(row.serial)
  if (!Number.isFinite(serial) || serial < 1) {
    throw new Error('The tracking number sequence returned no value.')
  }

  const year = new Date().getUTCFullYear()
  return `BT-${year}-${String(serial).padStart(5, '0')}`
}

/** The transitions available from a state, for documentation and clients. */
export function availableTransitions(status: ApplicationStatus): ApplicationStatus[] {
  return TRANSITIONS.filter((rule) => rule.from === status).map((rule) => rule.to)
}

/** Exposed so a test can assert the table has no unreachable states. */
export const APPLICATION_TRANSITIONS = TRANSITIONS

/** Every state that can end an application's life. */
export const APPLICATION_TERMINAL_STATUSES = TERMINAL_STATUSES
