import { sql } from 'drizzle-orm'
import {
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

import { userRoleEnum, userStatusEnum } from './enums.js'

/**
 * Platform accounts.
 *
 * Passwords are stored only as an Argon2id hash (`password_hash`); the hashing
 * implementation itself arrives with the authentication work. `role` defaults
 * to the least-privileged value and must be changed by an administrator, never
 * by the account itself.
 */
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    displayName: text('display_name').notNull(),
    role: userRoleEnum('role').notNull().default('applicant'),
    status: userStatusEnum('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Email uniqueness is case-insensitive.
    uniqueIndex('users_email_lower_unique').on(sql`lower(${table.email})`),
    index('users_role_idx').on(table.role),
  ],
)

export type User = typeof users.$inferSelect
export type NewUser = typeof users.$inferInsert
