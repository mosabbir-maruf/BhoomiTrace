import { and, desc, eq, sql } from 'drizzle-orm'

import type { Database } from '../db/client.js'
import { auditEvents, type AuditEvent, type NewAuditEvent } from '../db/schema/audit.js'
import type { UserRole } from '../db/schema/enums.js'
import type { Page, PaginationQuery } from '../lib/pagination.js'
import { pageOf } from '../lib/pagination.js'
import { redactForAudit } from '../lib/redact.js'

/**
 * The single writer for the append-only audit trail.
 *
 * Every security-sensitive and business-critical action goes through here, so
 * that the shape of an audit row is decided in one place. Nothing in this
 * module ever updates or deletes: `audit_events` rejects both by trigger, and a
 * correction is expressed by appending another row.
 *
 * The executor is accepted as a parameter so that an audit row can be written
 * inside the same transaction as the change it describes. When a business
 * operation and its audit entry must be atomic, they share one transaction;
 * the alternative — writing the audit row afterwards — can leave a change with
 * no record of who made it.
 */

/** Minimal surface shared by the pooled client and a transaction. */
export type AuditExecutor = Pick<Database['orm'], 'insert'>

/**
 * Who caused an event.
 *
 * A system event records no user, and is written with `actorRole = null` and a
 * `summary` that names the subsystem. It never borrows a human's identity, so
 * an automated action cannot be mistaken for a person's decision.
 */
export type AuditActor =
  | { kind: 'user'; userId: string; role: UserRole | null }
  | { kind: 'system'; system: string }

export interface AuditEventInput {
  actor: AuditActor
  /** Stable action identifier, e.g. `auth.login_succeeded`. */
  action: string
  entityType: string
  entityId?: string | null
  summary?: string
  /** Before/after detail. Passed through `redactForAudit` before storage. */
  changes?: Record<string, unknown> | null
  requestId?: string | null
}

/** The actor to record for an action nobody signed in to perform. */
export function systemActor(system: string): AuditActor {
  return { kind: 'system', system }
}

/**
 * Appends one audit event.
 *
 * Never throws for redaction reasons and never includes a password, token, or
 * cookie: `changes` is redacted by key name before it reaches the database.
 */
export async function recordAuditEvent(
  executor: AuditExecutor,
  input: AuditEventInput,
): Promise<void> {
  const row: NewAuditEvent = {
    actorId: input.actor.kind === 'user' ? input.actor.userId : null,
    actorRole: input.actor.kind === 'user' ? input.actor.role : null,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId ?? null,
    summary:
      input.summary ??
      (input.actor.kind === 'system'
        ? `System action by subsystem "${input.actor.system}".`
        : null),
    changes:
      input.changes === undefined || input.changes === null
        ? null
        : (redactForAudit(input.changes) as Record<string, unknown>),
    requestId: input.requestId ?? null,
  }

  await executor.insert(auditEvents).values(row)
}

/**
 * Stable audit action identifiers.
 *
 * Grouped under one object so that a typo is a compile error in callers that
 * import the constant, and so the complete vocabulary is auditable in one
 * place.
 */
export const AuditActions = {
  userRegistered: 'auth.register',
  loginSucceeded: 'auth.login_succeeded',
  loginFailed: 'auth.login_failed',
  logout: 'auth.logout',
  sessionExpired: 'auth.session_expired',
  accountSuspended: 'admin.account_suspended',
  accountBootstrapped: 'admin.account_bootstrapped',
  parcelCreated: 'parcel.created',
  parcelUpdated: 'parcel.updated',
  parcelRetired: 'parcel.retired',
  applicationCreated: 'application.created',
  applicationUpdated: 'application.updated',
  applicationStatusChanged: 'application.status_changed',
  lineageCreated: 'lineage.created',
  lineageCertaintyRaised: 'lineage.certainty_raised',
  documentRegistered: 'document.registered',
  documentMetadataUpdated: 'document.metadata_updated',
  extractionRecorded: 'extraction.recorded',
  extractionCorrected: 'extraction.corrected',
  findingRaised: 'finding.raised',
  findingResolved: 'finding.resolved',
  reviewDecisionRecorded: 'review.decision_recorded',
  readinessReportGenerated: 'readiness.report_generated',
  jobQueued: 'job.queued',
  jobStarted: 'job.started',
  jobCompleted: 'job.completed',
  jobFailed: 'job.failed',
  jobReviewRequired: 'job.review_required',
  jobRetryScheduled: 'job.retry_scheduled',
  jobLeaseRecovered: 'job.lease_recovered',
  jobCancelled: 'job.cancelled',
} as const

export interface AuditEventView {
  id: string
  actorId: string | null
  actorRole: UserRole | null
  action: string
  entityType: string
  entityId: string | null
  summary: string | null
  changes: Record<string, unknown> | null
  requestId: string | null
  createdAt: string
}

export function toAuditEventView(event: AuditEvent): AuditEventView {
  return {
    id: event.id,
    actorId: event.actorId,
    actorRole: event.actorRole,
    action: event.action,
    entityType: event.entityType,
    entityId: event.entityId,
    summary: event.summary,
    changes: event.changes ?? null,
    requestId: event.requestId,
    createdAt: event.createdAt.toISOString(),
  }
}

export interface AuditQuery {
  entityType?: string
  entityId?: string
  action?: string
  actorId?: string
  pagination: PaginationQuery
}

/**
 * Reads the audit trail, newest first.
 *
 * Read-only and deliberately without a mutation counterpart: there is no way to
 * change or remove an entry through this module, because there is no way to
 * change or remove one in the database either.
 */
export async function listAuditEvents(
  database: Database,
  query: AuditQuery,
): Promise<Page<AuditEventView>> {
  const where = and(
    query.entityType === undefined ? undefined : eq(auditEvents.entityType, query.entityType),
    query.entityId === undefined ? undefined : eq(auditEvents.entityId, query.entityId),
    query.action === undefined ? undefined : eq(auditEvents.action, query.action),
    query.actorId === undefined ? undefined : eq(auditEvents.actorId, query.actorId),
  )

  const [rows, counted] = await Promise.all([
    database.orm
      .select()
      .from(auditEvents)
      .where(where)
      .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id))
      .limit(query.pagination.limit)
      .offset(query.pagination.offset),
    database.orm
      .select({ count: sql<number>`count(*)::int` })
      .from(auditEvents)
      .where(where),
  ])

  return pageOf(rows.map(toAuditEventView), counted[0]?.count ?? 0, query.pagination)
}
