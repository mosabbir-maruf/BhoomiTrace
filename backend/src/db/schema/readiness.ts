import { sql } from 'drizzle-orm'
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core'

import { checklistOutcomeEnum, findingSeverityEnum, readinessOutcomeEnum } from './enums.js'
import { parcels } from './parcels.js'
import type { RecordReference } from './types.js'
import { users } from './users.js'

/**
 * A mutation-readiness report: a checklist a human reviewer can work through.
 *
 * This is administrative decision support, not an approval. It reports what the
 * deterministic rules found — missing evidence, unresolved findings, unverified
 * lineage, unreviewed values — and stops there. The report deliberately has no
 * single unexplained score, because a bare number would hide which checks
 * failed and why.
 *
 * Reports are generated append-only in practice: re-running the checklist
 * inserts a new report rather than rewriting the previous one, so a reviewer can
 * see what the picture looked like when a decision was taken.
 */
export const readinessReports = pgTable(
  'readiness_reports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    parcelId: uuid('parcel_id')
      .notNull()
      .references(() => parcels.id, { onDelete: 'restrict' }),
    requestedBy: uuid('requested_by').references(() => users.id, {
      onDelete: 'restrict',
    }),
    outcome: readinessOutcomeEnum('outcome').notNull(),
    /** Identifier of the rule set that produced the report. */
    rulesVersion: text('rules_version').notNull(),
    summary: text('summary').notNull(),
    /** Counts by outcome, so a caller need not aggregate the items itself. */
    counts: jsonb('counts').$type<Record<string, number>>(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('readiness_reports_parcel_idx').on(table.parcelId),
    index('readiness_reports_created_at_idx').on(table.createdAt),
  ],
)

/**
 * One check inside a readiness report.
 *
 * Every item states its stable rule code, what it looked at, what it expected,
 * and what it found, so the outcome can be explained without re-running the
 * rules or reading application source.
 */
export const readinessChecklistItems = pgTable(
  'readiness_checklist_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    reportId: uuid('report_id')
      .notNull()
      .references(() => readinessReports.id, { onDelete: 'cascade' }),
    ruleCode: text('rule_code').notNull(),
    outcome: checklistOutcomeEnum('outcome').notNull(),
    severity: findingSeverityEnum('severity').notNull().default('info'),
    title: text('title').notNull(),
    explanation: text('explanation').notNull(),
    observedValue: text('observed_value'),
    expectedValue: text('expected_value'),
    evidenceReference: text('evidence_reference'),
    /** Related records, as loose references rather than foreign keys. */
    recordReferences: jsonb('record_references').$type<RecordReference[]>(),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('readiness_checklist_items_report_idx').on(
      table.reportId,
      table.sortOrder,
    ),
    check(
      'readiness_checklist_items_sort_order_non_negative',
      sql`${table.sortOrder} >= 0`,
    ),
  ],
)

export type ReadinessReport = typeof readinessReports.$inferSelect
export type NewReadinessReport = typeof readinessReports.$inferInsert
export type ReadinessChecklistItem = typeof readinessChecklistItems.$inferSelect
export type NewReadinessChecklistItem = typeof readinessChecklistItems.$inferInsert
