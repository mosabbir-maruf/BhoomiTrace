import { and, eq, inArray } from 'drizzle-orm'

import type { Database } from '../db/client.js'
import { findings } from '../db/schema/findings.js'
import type { User } from '../db/schema/users.js'
import { NotFoundError } from '../lib/errors.js'
import {
  evaluateReconciliation,
  loadReconciliationContext,
  summariseOutcomes,
  type RuleResult,
} from '../validation/rules.js'
import { AuditActions, recordAuditEvent } from './audit.js'
import { loadVisibleParcel } from './parcels.js'

/**
 * Reconciliation: running the deterministic rules and turning the results into
 * records a person can work through.
 *
 * The rules themselves live in `../validation/rules.js` and are pure. This
 * module is the writing half: it raises findings for non-passing checks and
 * never touches a finding that is already open.
 *
 * ## Why findings are appended, not updated
 *
 * A finding is a prompt with a lifecycle; resolving or dismissing it is a
 * reviewer's act, recorded in `review_decisions`. When reconciliation runs
 * again and the same check fails, it does **not** reopen the resolved finding —
 * that would erase the fact that somebody already decided. It raises a new row
 * only if no finding for that rule is currently open, so the history shows the
 * problem was seen, decided, and seen again.
 */

export interface ReconciliationResult {
  parcelId: string
  rulesVersion: string
  rules: RuleResult[]
  summary: {
    outcome: 'ready_for_review' | 'needs_review' | 'not_ready'
    counts: Record<string, number>
    summary: string
  }
  /** Findings created by this run. Empty when `persist` was false. */
  raisedFindings: { id: string; ruleCode: string; title: string }[]
  /** Rule codes that were already open, so nothing new was raised. */
  existingOpenRules: string[]
}

/**
 * The read-only half of reconciliation: run the rules and decide what to raise.
 *
 * Nothing is written here, so it can run before a write transaction is opened.
 * That is what lets a worker evaluate outside a transaction and then persist the
 * findings and finalize the job atomically, in one transaction.
 */
export interface ReconciliationEvaluation {
  parcelId: string
  rulesVersion: string
  rules: RuleResult[]
  summary: {
    outcome: 'ready_for_review' | 'needs_review' | 'not_ready'
    counts: Record<string, number>
    summary: string
  }
  /** Non-passing rules that carry a finding kind: what is to be raised. */
  actionable: RuleResult[]
}

export interface ReconcileInput {
  user: User
  parcelId: string
  /** When true, findings are raised for non-passing checks. */
  persist: boolean
  requestId?: string | null
  rulesVersion: string
}

/** The executor surface the findings write needs. */
export type ReconciliationWriter = Pick<Database['orm'], 'select' | 'insert'>

/**
 * Runs the rules for a parcel the caller can see, writing nothing.
 *
 * Visibility is checked first: reconciling a record the caller cannot see is a
 * 404, not a silent success. The result is a plain value, so it can be produced
 * before any transaction is opened, and the write can then happen under a job's
 * lease fence without this read being inside that transaction.
 */
export async function evaluateParcelReconciliation(
  database: Database,
  input: { user: User; parcelId: string; rulesVersion: string },
): Promise<ReconciliationEvaluation> {
  await loadVisibleParcel(database, input.user, input.parcelId)

  const context = await loadReconciliationContext(database, input.parcelId)
  if (context === null) {
    throw new NotFoundError('No parcel exists with that identifier.')
  }

  const rules = await evaluateReconciliation(database, context)
  const summary = summariseOutcomes(rules)

  return {
    parcelId: input.parcelId,
    rulesVersion: input.rulesVersion,
    rules,
    summary: {
      outcome: summary.outcome,
      counts: { ...summary.counts },
      summary: summary.summary,
    },
    actionable: rules.filter(
      (rule) => rule.outcome !== 'pass' && rule.findingKind !== null,
    ),
  }
}

/**
 * Raises findings for an evaluation, inside the caller's transaction.
 *
 * The set of already-open rules is read here, in the same transaction as the
 * inserts, so "this rule is already open, so do not raise it again" is never
 * decided from a snapshot taken before the transaction began.
 */
export async function persistReconciliationFindings(
  tx: ReconciliationWriter,
  input: {
    user: User
    evaluation: ReconciliationEvaluation
    requestId?: string | null
  },
): Promise<{
  raisedFindings: { id: string; ruleCode: string; title: string }[]
  existingOpenRules: string[]
}> {
  const alreadyOpen = await tx
    .select({ ruleCode: findings.ruleCode })
    .from(findings)
    .where(
      and(
        eq(findings.parcelId, input.evaluation.parcelId),
        inArray(findings.status, ['open', 'under_review']),
      ),
    )

  const openRuleCodes = new Set(
    alreadyOpen
      .map((row) => row.ruleCode)
      .filter((code): code is string => code !== null),
  )

  const raised: { id: string; ruleCode: string; title: string }[] = []
  const skipped: string[] = []

  for (const rule of input.evaluation.actionable) {
    if (openRuleCodes.has(rule.ruleCode)) {
      skipped.push(rule.ruleCode)
      continue
    }

    const inserted = await tx
      .insert(findings)
      .values({
        parcelId: input.evaluation.parcelId,
        relatedParcelId: null,
        extractionId: null,
        kind: rule.findingKind ?? 'other',
        severity: rule.severity,
        status: 'open',
        title: rule.title,
        explanation: rule.explanation,
        evidenceReference: rule.evidenceReference,
        ruleCode: rule.ruleCode,
      })
      .returning({ id: findings.id })

    const finding = inserted[0]
    if (finding === undefined) {
      throw new Error('Finding insert did not return the created row.')
    }

    raised.push({ id: finding.id, ruleCode: rule.ruleCode, title: rule.title })

    await recordAuditEvent(tx, {
      actor: { kind: 'user', userId: input.user.id, role: input.user.role },
      action: AuditActions.findingRaised,
      entityType: 'finding',
      entityId: finding.id,
      summary: `Rule ${rule.ruleCode} raised a finding: ${rule.title}.`,
      changes: {
        ruleCode: rule.ruleCode,
        severity: rule.severity,
        outcome: rule.outcome,
        observedValue: rule.observedValue,
        expectedValue: rule.expectedValue,
      },
      requestId: input.requestId ?? null,
    })
  }

  return { raisedFindings: raised, existingOpenRules: skipped }
}

/** Runs the rules and, optionally, raises findings for what failed. */
export async function reconcileParcel(
  database: Database,
  input: ReconcileInput,
): Promise<ReconciliationResult> {
  const evaluation = await evaluateParcelReconciliation(database, {
    user: input.user,
    parcelId: input.parcelId,
    rulesVersion: input.rulesVersion,
  })

  if (!input.persist) {
    return {
      parcelId: evaluation.parcelId,
      rulesVersion: evaluation.rulesVersion,
      rules: evaluation.rules,
      summary: evaluation.summary,
      raisedFindings: [],
      existingOpenRules: [],
    }
  }

  const { raisedFindings, existingOpenRules } = await database.orm.transaction(
    (tx) =>
      persistReconciliationFindings(tx, {
        user: input.user,
        evaluation,
        requestId: input.requestId ?? null,
      }),
  )

  return {
    parcelId: evaluation.parcelId,
    rulesVersion: evaluation.rulesVersion,
    rules: evaluation.rules,
    summary: evaluation.summary,
    raisedFindings,
    existingOpenRules,
  }
}
