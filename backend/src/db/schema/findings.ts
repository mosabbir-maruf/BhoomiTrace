import { sql } from 'drizzle-orm'
import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core'

import { findingKindEnum, findingSeverityEnum, findingStatusEnum } from './enums.js'
import { extractions } from './extractions.js'
import { parcels } from './parcels.js'

/**
 * A discrepancy or observation raised for human review.
 *
 * A finding is an explainable prompt, not proof of anything: `explanation`
 * states what was compared and why it did not reconcile, and
 * `evidence_reference` points at the source. Findings are never auto-resolved.
 *
 * `version` is the optimistic-concurrency token, incremented by a database
 * trigger on every update, so two reviewers cannot silently overwrite each
 * other's resolution. `extraction_id` is `ON DELETE SET NULL` because a finding
 * is a mutable review prompt whose subject may legitimately change — unlike
 * `extractions.source_document_id`, which is evidence and is restricted.
 */
export const findings = pgTable(
  'findings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    parcelId: uuid('parcel_id')
      .notNull()
      .references(() => parcels.id, { onDelete: 'cascade' }),
    /** The other parcel involved, for cross-version comparisons. */
    relatedParcelId: uuid('related_parcel_id').references(() => parcels.id, {
      onDelete: 'set null',
    }),
    /** The specific extracted value the finding is about, when applicable. */
    extractionId: uuid('extraction_id').references(() => extractions.id, {
      onDelete: 'set null',
    }),
    kind: findingKindEnum('kind').notNull(),
    severity: findingSeverityEnum('severity').notNull().default('info'),
    status: findingStatusEnum('status').notNull().default('open'),
    title: text('title').notNull(),
    /** Plain-language description of the comparison that produced the finding. */
    explanation: text('explanation').notNull(),
    evidenceReference: text('evidence_reference'),
    /** Stable identifier of the rule that raised this finding, when it did. */
    ruleCode: text('rule_code'),
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('findings_parcel_idx').on(table.parcelId),
    index('findings_status_severity_idx').on(table.status, table.severity),
    index('findings_rule_code_idx').on(table.ruleCode),
    check('findings_version_positive', sql`${table.version} >= 1`),
  ],
)

export type Finding = typeof findings.$inferSelect
export type NewFinding = typeof findings.$inferInsert
