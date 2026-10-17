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

import { surveyVersionEnum } from './enums.js'

/**
 * A parcel as it appears in a single survey record (one khatian in one mouza).
 *
 * `area_decimal` is the recorded area in decimals (শতাংশ) and is stored as
 * `numeric(14, 4)` so comparisons are exact — never floating point.
 *
 * The ownership share is stored as a rational pair rather than a decimal so
 * that values such as 1/3 keep their exact meaning. `share_denominator` is
 * constrained to stay positive.
 */
export const parcels = pgTable(
  'parcels',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    survey: surveyVersionEnum('survey').notNull(),
    khatianNumber: text('khatian_number').notNull(),
    mouza: text('mouza').notNull(),
    jlNumber: text('jl_number').notNull(),
    upazila: text('upazila').notNull(),
    district: text('district').notNull(),
    areaDecimal: numeric('area_decimal', { precision: 14, scale: 4 }).notNull(),
    shareNumerator: integer('share_numerator').notNull().default(1),
    shareDenominator: integer('share_denominator').notNull().default(1),
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
