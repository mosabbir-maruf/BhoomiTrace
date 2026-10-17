import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  index,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core'

import { extractionFieldEnum, extractionReviewStatusEnum } from './enums.js'
import { sourceDocuments } from './documents.js'
import { parcels } from './parcels.js'
import { users } from './users.js'

/**
 * A single field read from a source document, kept separately from the value a
 * reviewer accepted.
 *
 * `recorded_value` is exactly what was read. `reviewed_value` is only populated
 * once a human has decided, so raw and reviewed values are never conflated.
 * `confidence` is nullable on purpose: a value with no recorded confidence must
 * not be given an invented one.
 */
export const extractions = pgTable(
  'extractions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    parcelId: uuid('parcel_id')
      .notNull()
      .references(() => parcels.id, { onDelete: 'cascade' }),
    sourceDocumentId: uuid('source_document_id').references(
      () => sourceDocuments.id,
      { onDelete: 'set null' },
    ),
    field: extractionFieldEnum('field').notNull(),
    recordedValue: text('recorded_value').notNull(),
    reviewedValue: text('reviewed_value'),
    reviewStatus: extractionReviewStatusEnum('review_status')
      .notNull()
      .default('pending'),
    /** Reader confidence between 0 and 1, when one was actually produced. */
    confidence: numeric('confidence', { precision: 4, scale: 3 }),
    isUnclear: boolean('is_unclear').notNull().default(false),
    /** Human-readable location within the document, e.g. "তফসিল, ঘর ৩". */
    pageReference: text('page_reference'),
    reviewedBy: uuid('reviewed_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('extractions_parcel_idx').on(table.parcelId),
    index('extractions_review_status_idx').on(table.reviewStatus),
    check(
      'extractions_confidence_range',
      sql`${table.confidence} is null or (${table.confidence} >= 0 and ${table.confidence} <= 1)`,
    ),
    check(
      'extractions_reviewed_value_consistency',
      sql`(${table.reviewStatus} = 'corrected') = (${table.reviewedValue} is not null)`,
    ),
  ],
)

export type Extraction = typeof extractions.$inferSelect
export type NewExtraction = typeof extractions.$inferInsert
