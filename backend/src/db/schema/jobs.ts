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
import { processingJobKindEnum, processingJobStatusEnum } from './enums.js'
import { parcels } from './parcels.js'
import { users } from './users.js'

/**
 * A durable unit of background work, queued in PostgreSQL.
 *
 * Extraction and reconciliation are too slow to run inside an HTTP request, so
 * a request records a job and returns; a separate worker process claims and
 * runs it. The queue lives in the same database as the data it operates on, so
 * claiming a job and writing its result can be one transaction. No in-memory
 * broker is involved, which means a restart loses nothing.
 *
 * Claiming uses `SELECT ... FOR UPDATE SKIP LOCKED`, so several workers can run
 * without two of them taking the same job. `leased_until` is the crash
 * recovery mechanism: a worker that dies mid-job leaves a lease that expires,
 * after which the job is reclaimable. `available_at` is the backoff clock —
 * a retry is only claimable once that time has passed.
 *
 * `idempotency_key` makes repeated client submissions safe: a second submission
 * with the same key returns the job already created instead of duplicating
 * expensive work. It is unique *per requester* and only among non-null values,
 * so two accounts may independently choose the same key without colliding or
 * seeing each other's work, and jobs that need no key are unaffected.
 *
 * References to the parcel and document are `ON DELETE RESTRICT`: a job either
 * explains why it exists or it does not, and losing its subject would leave an
 * unexplainable operational record. Parcels and documents are retired, not
 * deleted.
 */
export const processingJobs = pgTable(
  'processing_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: processingJobKindEnum('kind').notNull(),
    status: processingJobStatusEnum('status').notNull().default('queued'),
    parcelId: uuid('parcel_id').references(() => parcels.id, {
      onDelete: 'restrict',
    }),
    sourceDocumentId: uuid('source_document_id').references(
      () => sourceDocuments.id,
      { onDelete: 'restrict' },
    ),
    /** Null for work the system scheduled rather than a person. */
    requestedBy: uuid('requested_by').references(() => users.id, {
      onDelete: 'restrict',
    }),
    idempotencyKey: text('idempotency_key'),
    /** Non-sensitive job inputs. Must never hold document contents or secrets. */
    payload: jsonb('payload').$type<Record<string, unknown>>(),
    /** Non-sensitive job outputs, e.g. identifiers of rows produced. */
    result: jsonb('result').$type<Record<string, unknown>>(),
    attemptCount: integer('attempt_count').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(3),
    /** Backoff clock: the job is not claimable before this instant. */
    availableAt: timestamp('available_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** Set while a worker holds the job; expiry makes it reclaimable. */
    leasedUntil: timestamp('leased_until', { withTimezone: true }),
    /** Identifies the worker holding the lease. */
    lockedBy: text('locked_by'),
    /** Redacted failure summary. Never a stack trace or document contents. */
    lastError: text('last_error'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // The claim query: ready jobs by status and availability.
    index('processing_jobs_claim_idx').on(table.status, table.availableAt),
    // Idempotency is scoped to the requester, never global. A client-chosen key
    // cannot be allowed to reach across accounts: with one global index, two
    // people could pick the same key and one of them would be handed the
    // other's job. Two partial indexes express the two cases separately, because
    // PostgreSQL treats `NULL` as distinct in a unique index, so a single
    // `(requested_by, idempotency_key)` index would not constrain the
    // system-scheduled jobs at all.
    uniqueIndex('processing_jobs_idempotency_key_user_unique')
      .on(table.requestedBy, table.idempotencyKey)
      .where(
        sql`${table.requestedBy} is not null and ${table.idempotencyKey} is not null`,
      ),
    // System-scheduled work (no requester) is still deduplicated among itself.
    uniqueIndex('processing_jobs_idempotency_key_system_unique')
      .on(table.idempotencyKey)
      .where(
        sql`${table.requestedBy} is null and ${table.idempotencyKey} is not null`,
      ),
    index('processing_jobs_parcel_idx').on(table.parcelId),
    index('processing_jobs_document_idx').on(table.sourceDocumentId),
    index('processing_jobs_requested_by_idx').on(table.requestedBy),
    check(
      'processing_jobs_attempts_non_negative',
      sql`${table.attemptCount} >= 0`,
    ),
    check('processing_jobs_max_attempts_positive', sql`${table.maxAttempts} >= 1`),
  ],
)

export type ProcessingJob = typeof processingJobs.$inferSelect
export type NewProcessingJob = typeof processingJobs.$inferInsert
