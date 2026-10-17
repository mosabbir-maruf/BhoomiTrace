import { and, asc, desc, eq } from 'drizzle-orm'

import type { Database } from '../db/client.js'
import type {
  ChecklistOutcome,
  FindingSeverity,
  ReadinessOutcome,
} from '../db/schema/enums.js'
import { parcels } from '../db/schema/parcels.js'
import {
  readinessChecklistItems,
  readinessReports,
  type ReadinessChecklistItem,
  type ReadinessReport,
} from '../db/schema/readiness.js'
import type { RecordReference } from '../db/schema/types.js'
import type { User } from '../db/schema/users.js'
import { NotFoundError } from '../lib/errors.js'
import {
  evaluateReconciliation,
  loadReconciliationContext,
  summariseOutcomes,
} from '../validation/rules.js'
import { AuditActions, recordAuditEvent } from './audit.js'
import { loadVisibleParcel } from './parcels.js'

/**
 * Mutation-readiness reports.
 *
 * A report is a checklist, not a score. Every item states its rule, its outcome,
 * what was observed, what was expected, and which records and evidence it
 * refers to, so a reviewer can see *why* the report reads the way it does.
 *
 * What a report is not: it is not an approval, it is not a legal opinion, and it
 * makes no claim about ownership. The outcome vocabulary is deliberately
 * administrative — `ready_for_review`, `needs_review`, `not_ready` — and the
 * summary text says so in plain language.
 *
 * Reports are append-only in practice: generating again inserts a new report and
 * leaves the previous one intact, so the picture a decision was taken against
 * remains readable.
 */

export interface ReadinessChecklistItemView {
  id: string
  ruleCode: string
  outcome: ChecklistOutcome
  severity: FindingSeverity
  title: string
  explanation: string
  observedValue: string | null
  expectedValue: string | null
  evidenceReference: string | null
  recordReferences: RecordReference[]
  sortOrder: number
}

export function toChecklistItemView(
  item: ReadinessChecklistItem,
): ReadinessChecklistItemView {
  return {
    id: item.id,
    ruleCode: item.ruleCode,
    outcome: item.outcome,
    severity: item.severity,
    title: item.title,
    explanation: item.explanation,
    observedValue: item.observedValue,
    expectedValue: item.expectedValue,
    evidenceReference: item.evidenceReference,
    recordReferences: item.recordReferences ?? [],
    sortOrder: item.sortOrder,
  }
}

export interface ReadinessReportView {
  id: string
  parcelId: string
  requestedBy: string | null
  outcome: ReadinessOutcome
  rulesVersion: string
  summary: string
  counts: Record<string, number> | null
  createdAt: string
  items: ReadinessChecklistItemView[]
}

export interface GenerateReadinessInput {
  user: User
  parcelId: string
  rulesVersion: string
  requestId?: string | null
}

/**
 * Evaluates the rule set and stores the result as a report.
 *
 * Nothing is written unless the caller can see the parcel, so a report can never
 * become an oracle for a record the caller is not allowed to read.
 */
export async function generateReadinessReport(
  database: Database,
  input: GenerateReadinessInput,
): Promise<ReadinessReportView> {
  await loadVisibleParcel(database, input.user, input.parcelId)

  const context = await loadReconciliationContext(database, input.parcelId)
  if (context === null) {
    throw new NotFoundError('No parcel exists with that identifier.')
  }

  const rules = await evaluateReconciliation(database, context)
  const summary = summariseOutcomes(rules)

  const reportId = await database.orm.transaction(async (tx) => {
    const inserted = await tx
      .insert(readinessReports)
      .values({
        parcelId: input.parcelId,
        requestedBy: input.user.id,
        outcome: summary.outcome,
        rulesVersion: input.rulesVersion,
        summary: summary.summary,
        counts: { ...summary.counts },
      })
      .returning({ id: readinessReports.id })

    const report = inserted[0]
    if (report === undefined) {
      throw new Error('Readiness report insert did not return the created row.')
    }

    if (rules.length > 0) {
      await tx.insert(readinessChecklistItems).values(
        rules.map((rule, index) => ({
          reportId: report.id,
          ruleCode: rule.ruleCode,
          outcome: rule.outcome,
          severity: rule.severity,
          title: rule.title,
          explanation: rule.explanation,
          observedValue: rule.observedValue,
          expectedValue: rule.expectedValue,
          evidenceReference: rule.evidenceReference,
          recordReferences: rule.recordReferences,
          sortOrder: index,
        })),
      )
    }

    await recordAuditEvent(tx, {
      actor: { kind: 'user', userId: input.user.id, role: input.user.role },
      action: AuditActions.readinessReportGenerated,
      entityType: 'readiness_report',
      entityId: report.id,
      summary: `Readiness report generated: ${summary.outcome}.`,
      changes: {
        parcelId: input.parcelId,
        rulesVersion: input.rulesVersion,
        counts: summary.counts,
        checklistItems: rules.length,
      },
      requestId: input.requestId ?? null,
    })

    return report.id
  })

  return loadReadinessReport(database, input.user, reportId)
}

/**
 * Loads a report with its checklist.
 *
 * Visibility follows the parcel, so a report identifier does not let one
 * applicant read another's record.
 */
export async function loadReadinessReport(
  database: Database,
  user: User,
  reportId: string,
): Promise<ReadinessReportView> {
  const rows = await database.orm
    .select({ report: readinessReports })
    .from(readinessReports)
    .innerJoin(parcels, eq(parcels.id, readinessReports.parcelId))
    .where(
      and(
        eq(readinessReports.id, reportId),
        user.role === 'applicant' ? eq(parcels.ownerId, user.id) : undefined,
      ),
    )
    .limit(1)

  const row = rows[0]
  if (row === undefined) {
    throw new NotFoundError('No readiness report exists with that identifier.')
  }

  const items = await database.orm
    .select()
    .from(readinessChecklistItems)
    .where(eq(readinessChecklistItems.reportId, reportId))
    .orderBy(asc(readinessChecklistItems.sortOrder))

  return {
    ...toReportView(row.report),
    items: items.map(toChecklistItemView),
  }
}

/** Lists a parcel's reports, newest first, without their checklists. */
export async function listReadinessReportsForParcel(
  database: Database,
  user: User,
  parcelId: string,
): Promise<Omit<ReadinessReportView, 'items'>[]> {
  await loadVisibleParcel(database, user, parcelId)

  const rows = await database.orm
    .select()
    .from(readinessReports)
    .where(eq(readinessReports.parcelId, parcelId))
    .orderBy(desc(readinessReports.createdAt))

  return rows.map(toReportView)
}

/** The most recent report for a parcel, or null when none exists. */
export async function latestReadinessReport(
  database: Database,
  user: User,
  parcelId: string,
): Promise<ReadinessReportView | null> {
  await loadVisibleParcel(database, user, parcelId)

  const rows = await database.orm
    .select({ id: readinessReports.id })
    .from(readinessReports)
    .where(eq(readinessReports.parcelId, parcelId))
    .orderBy(desc(readinessReports.createdAt))
    .limit(1)

  const latest = rows[0]
  if (latest === undefined) return null

  return loadReadinessReport(database, user, latest.id)
}

function toReportView(report: ReadinessReport): Omit<ReadinessReportView, 'items'> {
  return {
    id: report.id,
    parcelId: report.parcelId,
    requestedBy: report.requestedBy,
    outcome: report.outcome,
    rulesVersion: report.rulesVersion,
    summary: report.summary,
    counts: report.counts ?? null,
    createdAt: report.createdAt.toISOString(),
  }
}
