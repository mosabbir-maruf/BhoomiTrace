import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

import { users } from './users.js'

/**
 * A database-backed login session.
 *
 * Only a SHA-256 hash of the opaque session token is stored, so a database
 * disclosure cannot be replayed as a live session. The token itself is a
 * 256-bit random value, which is why a fast hash is appropriate here: there is
 * no low-entropy secret to brute-force, unlike a password (which uses Argon2id).
 *
 * `csrf_token_hash` implements the synchronizer-token pattern: the CSRF token
 * is delivered in a readable cookie while its hash is bound to this session, so
 * a token minted for one session cannot be replayed against another.
 *
 * Rows are operational, not historical: logout deletes the row, suspending an
 * account deletes every row for that user, and an expiry sweeper removes rows
 * whose `expires_at` has passed. The foreign key therefore cascades, which is
 * correct for a table that carries no history — unlike `audit_events` and
 * `review_decisions`, which are append-only and restricted.
 */
export const authSessions = pgTable(
  'auth_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** SHA-256 (hex) of the session token. The token itself is never stored. */
    tokenHash: text('token_hash').notNull(),
    /** SHA-256 (hex) of the CSRF token bound to this session. */
    csrfTokenHash: text('csrf_token_hash').notNull(),
    /** User agent, truncated, for the account's own session listing only. */
    userAgent: text('user_agent'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('auth_sessions_token_hash_unique').on(table.tokenHash),
    index('auth_sessions_user_idx').on(table.userId),
    // Supports the expiry sweeper.
    index('auth_sessions_expires_at_idx').on(table.expiresAt),
  ],
)

export type AuthSession = typeof authSessions.$inferSelect
export type NewAuthSession = typeof authSessions.$inferInsert
