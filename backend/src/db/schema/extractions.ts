import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core'

import { extractionFieldEnum, extractionReviewStatusEnum } from './enums.js'
import { sourceDocuments } from './documents.js'
import { documentPages } from './pages.js'
import { parcels } from './parcels.js'
import type { BoundingBox } from './types.js'
import { users } from './users.js'

/**
 * A single field read from a source document, kept separately from the value a
 * reviewer accepted.
 *
 * `recorded_value` is exactly what was read. `reviewed_value` is only populated
 * once a human has decided, so raw and reviewed values are never conflated.
 * `confidence` is nullable on purpose: a value with no recorded confidence must
 * not be given an invented one.
 *
 * `source_document_id` is nullable so a manual-entry extraction can stand on its
 * own, and is `ON DELETE RESTRICT` so that a document which evidence depends on
 * cannot be removed. `SET NULL` would erase provenance silently — the extraction
 * would survive with no way to say where the value came from. Documents are
 * retired by status instead of being hard-deleted. See the deletion policy in
 * `./index.js`.
 *
 * `page_id` and `bounding_box` are provenance too, and are populated only from
 * what the provider actually reported. `provider`/`provider_model` name the
 * reader that produced the value, so a mock read is never mistakable for a real
 * one.
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
      { onDelete: 'restrict' },
    ),
    /** The specific page inside the document, when the provider named one. */
    pageId: uuid('page_id').references(() => documentPages.id, {
      onDelete: 'restrict',
    }),
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
    /** Normalised source region, only when the provider reported one. */
    boundingBox: jsonb('bounding_box').$type<BoundingBox>(),
    /** Name of the extraction provider that produced this read. */
    provider: text('provider'),
    /** Model identifier reported by that provider, when it names one. */
    providerModel: text('provider_model'),
    /** When the provider produced the read (not when the row was written). */
    extractedAt: timestamp('extracted_at', { withTimezone: true }),
    reviewedBy: uuid('reviewed_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    /** Optimistic-concurrency token, incremented by a database trigger. */
    version: integer('version').notNull().default(1),
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
    // Supports the RESTRICT check performed when a source document is deleted.
    index('extractions_source_document_idx').on(table.sourceDocumentId),
    index('extractions_page_idx').on(table.pageId),
    check(
      'extractions_confidence_range',
      sql`${table.confidence} is null or (${table.confidence} >= 0 and ${table.confidence} <= 1)`,
    ),
    check(
      'extractions_reviewed_value_consistency',
      sql`(${table.reviewStatus} = 'corrected') = (${table.reviewedValue} is not null)`,
    ),
    check('extractions_version_positive', sql`${table.version} >= 1`),
  ],
)

export type Extraction = typeof extractions.$inferSelect
export type NewExtraction = typeof extractions.$inferInsert
