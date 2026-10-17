import { sql } from 'drizzle-orm'
import {
  check,
  index,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core'

import { reviewOutcomeEnum } from './enums.js'
import { extractions } from './extractions.js'
import { findings } from './findings.js'
import { users } from './users.js'

/**
 * An append-only record of a reviewer's decision.
 *
 * Rows are never updated or deleted — the database enforces this with a trigger
 * (see the append-only guards migration). Correcting an earlier decision adds a
 * new row, so review history stays intact.
 *
 * Every decision must concern either a finding or an extraction.
 */
export const reviewDecisions = pgTable(
  'review_decisions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    findingId: uuid('finding_id').references(() => findings.id, {
      onDelete: 'cascade',
    }),
    extractionId: uuid('extraction_id').references(() => extractions.id, {
      onDelete: 'set null',
    }),
    reviewerId: uuid('reviewer_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    outcome: reviewOutcomeEnum('outcome').notNull(),
    /** The value as recorded, captured at decision time. */
    extractedValue: text('extracted_value'),
    /** The value the reviewer proposes instead, for a correction. */
    proposedValue: text('proposed_value'),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('review_decisions_finding_idx').on(table.findingId),
    index('review_decisions_extraction_idx').on(table.extractionId),
    index('review_decisions_reviewer_idx').on(table.reviewerId),
    check(
      'review_decisions_target_present',
      sql`${table.findingId} is not null or ${table.extractionId} is not null`,
    ),
    check(
      'review_decisions_proposed_value_matches_outcome',
      sql`(${table.outcome} = 'correction') or ${table.proposedValue} is null`,
    ),
  ],
)

export type ReviewDecision = typeof reviewDecisions.$inferSelect
export type NewReviewDecision = typeof reviewDecisions.$inferInsert
