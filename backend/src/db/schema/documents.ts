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

import { documentStatusEnum, sourceDocumentKindEnum } from './enums.js'
import { users } from './users.js'

/**
 * A source document that extracted values can point back to.
 *
 * Every synthetic record is registered here so that findings and extractions
 * keep a stable, reviewable evidence trail (`reference`, `page_count`,
 * `checksum_sha256`).
 */
export const sourceDocuments = pgTable(
  'source_documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    title: text('title').notNull(),
    kind: sourceDocumentKindEnum('kind').notNull().default('synthetic_demo'),
    /** Call number, synthetic file identifier, or external anchor. */
    reference: text('reference'),
    pageCount: integer('page_count'),
    checksumSha256: text('checksum_sha256'),
    status: documentStatusEnum('status').notNull().default('submitted'),
    createdBy: uuid('created_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('source_documents_status_idx').on(table.status),
    check(
      'source_documents_page_count_non_negative',
      sql`${table.pageCount} is null or ${table.pageCount} >= 0`,
    ),
    check(
      'source_documents_checksum_shape',
      sql`${table.checksumSha256} is null or ${table.checksumSha256} ~ '^[0-9a-f]{64}$'`,
    ),
  ],
)

export type SourceDocument = typeof sourceDocuments.$inferSelect
export type NewSourceDocument = typeof sourceDocuments.$inferInsert
