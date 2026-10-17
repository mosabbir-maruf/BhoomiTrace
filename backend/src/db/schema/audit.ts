import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core'

import { userRoleEnum } from './enums.js'
import { users } from './users.js'

/**
 * Append-only audit trail.
 *
 * Rows are never updated or deleted (enforced by trigger). `actor_role` is
 * snapshotted so the record stays meaningful if the account later changes.
 * `changes` must only ever contain redacted, non-secret values.
 *
 * `action` and `entity_type` are free-form text rather than enums so that new
 * event types do not require a migration.
 */
export const auditEvents = pgTable(
  'audit_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    actorId: uuid('actor_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    actorRole: userRoleEnum('actor_role'),
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id'),
    summary: text('summary'),
    /** Redacted before/after snapshot. Never contains secrets. */
    changes: jsonb('changes').$type<Record<string, unknown>>(),
    /** Correlates the event with the request that caused it. */
    requestId: text('request_id'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('audit_events_entity_idx').on(table.entityType, table.entityId),
    index('audit_events_actor_idx').on(table.actorId),
    index('audit_events_created_at_idx').on(table.createdAt),
  ],
)

export type AuditEvent = typeof auditEvents.$inferSelect
export type NewAuditEvent = typeof auditEvents.$inferInsert
