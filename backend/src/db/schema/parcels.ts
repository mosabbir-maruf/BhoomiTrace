import { sql } from 'drizzle-orm'
import {
  check,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

import { dataOriginEnum, surveyVersionEnum } from './enums.js'
import { users } from './users.js'

/**
 * A parcel as it appears in a single survey record (one khatian in one mouza).
 *
 * `area_decimal` is the recorded area in decimals (শতাংশ) and is stored as
 * `numeric(14, 4)` so comparisons are exact — never floating point.
 *
 * The ownership share is stored as a rational pair rather than a decimal so
 * that values such as 1/3 keep their exact meaning. `share_denominator` is
 * constrained to stay positive.
 *
 * `owner_id` is the account a parcel belongs to. It is nullable because seeded
 * demo parcels belong to nobody, and an applicant's access is decided by this
 * column — never by anything the client sends. `ON DELETE RESTRICT` keeps a
 * parcel from being orphaned by a user delete; accounts are suspended instead.
 *
 * `version` is the optimistic-concurrency token, incremented by a database
 * trigger on every update. A writer states the version it read; a mismatch
 * means somebody else got there first and the write is rejected rather than
 * silently overwriting their change.
 */
export const parcels = pgTable(
  'parcels',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id').references(() => users.id, {
      onDelete: 'restrict',
    }),
    origin: dataOriginEnum('origin').notNull(),
    survey: surveyVersionEnum('survey').notNull(),
    khatianNumber: text('khatian_number').notNull(),
    mouza: text('mouza').notNull(),
    jlNumber: text('jl_number').notNull(),
    upazila: text('upazila').notNull(),
    district: text('district').notNull(),
    areaDecimal: numeric('area_decimal', { precision: 14, scale: 4 }).notNull(),
    shareNumerator: integer('share_numerator').notNull().default(1),
    shareDenominator: integer('share_denominator').notNull().default(1),
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // A khatian number identifies a parcel uniquely within a survey and mouza.
    uniqueIndex('parcels_identity_unique').on(
      table.survey,
      table.district,
      table.upazila,
      table.mouza,
      table.jlNumber,
      table.khatianNumber,
    ),
    index('parcels_location_idx').on(
      table.district,
      table.upazila,
      table.mouza,
    ),
    index('parcels_owner_idx').on(table.ownerId),
    check(
      'parcels_area_non_negative',
      sql`${table.areaDecimal} >= 0`,
    ),
    check(
      'parcels_share_numerator_non_negative',
      sql`${table.shareNumerator} >= 0`,
    ),
    check(
      'parcels_share_denominator_positive',
      sql`${table.shareDenominator} > 0`,
    ),
    check('parcels_version_positive', sql`${table.version} >= 1`),
  ],
)

/**
 * Dag (plot) numbers belonging to a parcel. Normalised as its own table because
 * a single khatian can cover several dags.
 */
export const parcelDags = pgTable(
  'parcel_dags',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    parcelId: uuid('parcel_id')
      .notNull()
      .references(() => parcels.id, { onDelete: 'cascade' }),
    dagNumber: text('dag_number').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('parcel_dags_parcel_dag_unique').on(
      table.parcelId,
      table.dagNumber,
    ),
  ],
)

export type Parcel = typeof parcels.$inferSelect
export type NewParcel = typeof parcels.$inferInsert
export type ParcelDag = typeof parcelDags.$inferSelect
export type NewParcelDag = typeof parcelDags.$inferInsert
