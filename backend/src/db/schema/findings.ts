import {
  index,
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
  ],
)

export type Finding = typeof findings.$inferSelect
export type NewFinding = typeof findings.$inferInsert
