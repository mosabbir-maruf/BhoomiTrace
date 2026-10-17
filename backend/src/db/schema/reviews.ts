import { sql } from 'drizzle-orm'
import {
  check,
  index,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core'

import { findingReviewActionEnum, reviewOutcomeEnum } from './enums.js'
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
 *
 * All foreign keys held by this table are `ON DELETE RESTRICT`. A `CASCADE` or
 * `SET NULL` action here would make PostgreSQL mutate or remove an append-only
 * row as a side effect of deleting something else, which the append-only trigger
 * rejects. `RESTRICT` states the intended policy directly: a decision's subject
 * and its author cannot be deleted while the decision exists. Subjects that must
 * "go away" are retired with a status column instead of being hard-deleted.
 */
export const reviewDecisions = pgTable(
  'review_decisions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    findingId: uuid('finding_id').references(() => findings.id, {
      onDelete: 'restrict',
    }),
    extractionId: uuid('extraction_id').references(() => extractions.id, {
      onDelete: 'restrict',
    }),
    reviewerId: uuid('reviewer_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    outcome: reviewOutcomeEnum('outcome').notNull(),
    /**
     * The explicit action taken on a finding, when this decision concerns one.
     *
     * `null` for extraction decisions, and also for finding decisions recorded
     * before this column existed — those rows are append-only and are never
     * rewritten to backfill a value, so a reader must treat `null` as "recorded
     * before the action was stored separately". The audit trail holds the action
     * for those rows.
     */
    findingAction: findingReviewActionEnum('finding_action'),
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
    // A finding action describes a finding. Allowing one on an extraction
    // decision would create a row whose two halves contradict each other.
    check(
      'review_decisions_finding_action_scope',
      sql`${table.findingAction} is null or ${table.findingId} is not null`,
    ),
  ],
)

export type ReviewDecision = typeof reviewDecisions.$inferSelect
export type NewReviewDecision = typeof reviewDecisions.$inferInsert
