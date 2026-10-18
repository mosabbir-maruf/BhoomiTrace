import { sql } from 'drizzle-orm'
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

import { sourceDocuments } from './documents.js'
import type { BoundingBox } from './types.js'

/**
 * A structured page reference inside a source document.
 *
 * Extractions point at a page when the reader reported one, which is how a
 * reviewer can check a value against the record instead of trusting a summary.
 * Nothing here is invented: `region` is null unless the extraction provider
 * actually supplied a bounding box, and `width`/`height` are null unless the
 * provider reported the page geometry. A page row with no geometry is still
 * useful — it records that a page exists and what it is called.
 *
 * Pages cascade with their document, which is safe precisely because
 * `extractions.source_document_id` is `ON DELETE RESTRICT`: a document that any
 * extraction depends on cannot be deleted, so its pages cannot be swept away
 * from under a provenance link.
 */
export const documentPages = pgTable(
  'document_pages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sourceDocumentId: uuid('source_document_id')
      .notNull()
      .references(() => sourceDocuments.id, { onDelete: 'cascade' }),
    /** 1-based page number as printed in the record. */
    pageNumber: integer('page_number').notNull(),
    /** Human-readable label, e.g. "তফসিল" or "স্বত্বের বিবরণ". */
    label: text('label'),
    /** Page geometry, only when the provider reported it. */
    width: integer('width'),
    height: integer('height'),
    /** Normalised region (0–1) reported by the provider, when available. */
    region: jsonb('region').$type<BoundingBox>(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('document_pages_document_page_unique').on(
      table.sourceDocumentId,
      table.pageNumber,
    ),
    index('document_pages_document_idx').on(table.sourceDocumentId),
    check('document_pages_page_number_positive', sql`${table.pageNumber} >= 1`),
    check(
      'document_pages_dimensions_positive',
      sql`(${table.width} is null or ${table.width} > 0) and (${table.height} is null or ${table.height} > 0)`,
    ),
  ],
)

export type DocumentPage = typeof documentPages.$inferSelect
export type NewDocumentPage = typeof documentPages.$inferInsert
