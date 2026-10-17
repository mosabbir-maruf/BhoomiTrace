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

export interface ReconcileInput {
  user: User
  parcelId: string
  /** When true, findings are raised for non-passing checks. */
  persist: boolean
  requestId?: string | null
  rulesVersion: string
}

/** Runs the rules and, optionally, raises findings for what failed. */
export async function reconcileParcel(
  database: Database,
  input: ReconcileInput,
): Promise<ReconciliationResult> {
  // Visibility first: reconciling a record the caller cannot see is a 404, not
  // a silent success.
  await loadVisibleParcel(database, input.user, input.parcelId)

  const context = await loadReconciliationContext(database, input.parcelId)
  if (context === null) {
    throw new NotFoundError('No parcel exists with that identifier.')
  }

  const rules = await evaluateReconciliation(database, context)
  const summary = summariseOutcomes(rules)

  if (!input.persist) {
    return {
      parcelId: input.parcelId,
      rulesVersion: input.rulesVersion,
      rules,
      summary: {
        outcome: summary.outcome,
        counts: { ...summary.counts },
        summary: summary.summary,
      },
      raisedFindings: [],
      existingOpenRules: [],
    }
  }

  const actionable = rules.filter(
    (rule) => rule.outcome !== 'pass' && rule.findingKind !== null,
  )

  const alreadyOpen = await database.orm
    .select({ ruleCode: findings.ruleCode })
    .from(findings)
    .where(
      and(
        eq(findings.parcelId, input.parcelId),
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

  await database.orm.transaction(async (tx) => {
    for (const rule of actionable) {
      if (openRuleCodes.has(rule.ruleCode)) {
        skipped.push(rule.ruleCode)
        continue
      }

      const inserted = await tx
        .insert(findings)
        .values({
          parcelId: input.parcelId,
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
  })

  return {
    parcelId: input.parcelId,
    rulesVersion: input.rulesVersion,
    rules,
    summary: {
      outcome: summary.outcome,
      counts: { ...summary.counts },
      summary: summary.summary,
    },
    raisedFindings: raised,
    existingOpenRules: skipped,
  }
}
