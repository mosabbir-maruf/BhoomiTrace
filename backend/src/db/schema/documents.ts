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

import { dataOriginEnum, documentStatusEnum, sourceDocumentKindEnum } from './enums.js'
import { users } from './users.js'

/**
 * A source document that extracted values can point back to.
 *
 * Every synthetic record is registered here so that findings and extractions
 * keep a stable, reviewable evidence trail (`reference`, `page_count`,
 * `checksum_sha256`).
 *
 * `owner_id` is the account that filed the document. Nullable so seeded demo
 * documents belong to nobody. It is `ON DELETE RESTRICT`, consistent with the
 * rule that records carrying evidence are not hard-deleted; accounts are
 * suspended instead.
 *
 * `origin` separates the seeded demo dataset from user-created records and has
 * no database default, so every writer must classify what it stores rather than
 * inheriting a label by accident.
 *
 * A stored file is identified by `storage_key`, which is server-generated. A
 * caller-supplied path is never used, so a filename cannot escape the private
 * storage directory.
 */
export const sourceDocuments = pgTable(
  'source_documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id').references(() => users.id, {
      onDelete: 'restrict',
    }),
    origin: dataOriginEnum('origin').notNull(),
    title: text('title').notNull(),
    kind: sourceDocumentKindEnum('kind').notNull().default('synthetic_demo'),
    /** Call number, synthetic file identifier, or external anchor. */
    reference: text('reference'),
    pageCount: integer('page_count'),
    checksumSha256: text('checksum_sha256'),
    status: documentStatusEnum('status').notNull().default('submitted'),
    /** Server-generated identifier of the stored file, never a caller path. */
    storageKey: text('storage_key'),
    /** Original client filename, kept for display only and never used as a path. */
    originalFilename: text('original_filename'),
    contentType: text('content_type'),
    byteSize: integer('byte_size'),
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
    index('source_documents_owner_idx').on(table.ownerId),
    check(
      'source_documents_page_count_non_negative',
      sql`${table.pageCount} is null or ${table.pageCount} >= 0`,
    ),
    check(
      'source_documents_checksum_shape',
      sql`${table.checksumSha256} is null or ${table.checksumSha256} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'source_documents_byte_size_non_negative',
      sql`${table.byteSize} is null or ${table.byteSize} >= 0`,
    ),
  ],
)

export type SourceDocument = typeof sourceDocuments.$inferSelect
export type NewSourceDocument = typeof sourceDocuments.$inferInsert
