import { sql } from 'drizzle-orm'
import {
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

import { lineageCertaintyEnum, lineageRelationEnum } from './enums.js'
import { parcels } from './parcels.js'
import { users } from './users.js'

/**
 * A directed lineage link between two parcels across survey versions.
 *
 * The link carries its own evidence reference and a certainty level, because an
 * unevidenced connection must never be presented as confirmed. Deleting a
 * parcel is restricted while links reference it, so lineage history cannot be
 * silently orphaned.
 */
export const parcelLineage = pgTable(
  'parcel_lineage',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    fromParcelId: uuid('from_parcel_id')
      .notNull()
      .references(() => parcels.id, { onDelete: 'restrict' }),
    toParcelId: uuid('to_parcel_id')
      .notNull()
      .references(() => parcels.id, { onDelete: 'restrict' }),
    relation: lineageRelationEnum('relation').notNull(),
    certainty: lineageCertaintyEnum('certainty').notNull().default('unverified'),
    /** Where the link can be checked, for example "RS পৃষ্ঠা ০৩৪ / BS পৃষ্ঠা ০৪১". */
    evidenceReference: text('evidence_reference'),
    note: text('note'),
    createdBy: uuid('created_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('parcel_lineage_edge_unique').on(
      table.fromParcelId,
      table.toParcelId,
      table.relation,
    ),
    index('parcel_lineage_to_idx').on(table.toParcelId),
    check(
      'parcel_lineage_not_self_referential',
      sql`${table.fromParcelId} <> ${table.toParcelId}`,
    ),
  ],
)

export type ParcelLineage = typeof parcelLineage.$inferSelect
export type NewParcelLineage = typeof parcelLineage.$inferInsert
