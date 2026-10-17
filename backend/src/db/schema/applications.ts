import { sql } from 'drizzle-orm'
import {
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgSequence,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

import {
  applicationStatusEnum,
  applicationTypeEnum,
  dataOriginEnum,
} from './enums.js'
import { parcels } from './parcels.js'
import { users } from './users.js'

/**
 * The source of application tracking numbers.
 *
 * A reference number must be unique across every application and two
 * submissions can arrive in the same instant, so the number is drawn from a
 * sequence rather than counted: `nextval` is atomic, and a sequence never
 * reuses a value. Counting existing rows would need a lock to be correct and
 * would repeat a number if a row were ever removed. The unique index on
 * `applications.tracking_number` is a backstop, not the mechanism.
 */
export const applicationsTrackingNumberSequence = pgSequence(
  'applications_tracking_number_seq',
  { startWith: 1 },
)

/**
 * An application a person files with the platform.
 *
 * ## What this is, and what it deliberately is not
 *
 * This table tracks an application through a set of states. It does **not**
 * record a government decision and nothing here confers, transfers, or confirms
 * any right in land. The states exist so a filing can be followed from draft to
 * a settled outcome inside this system; the words used for the outcomes are the
 * system's own vocabulary, not statutory language.
 *
 * Where a real mutation process would impose a statutory workflow — which
 * authority may decide, the legally required steps and their order, the exact
 * wording of a decision, the documents that must be examined, and the appeal
 * path — this demo tracks the *shape* of a workflow without claiming to be it.
 * See the README's "Applications" section for the product decisions that must be
 * taken before any of those states could be presented as an official outcome.
 * The API never states that an application is legally approved, only that it
 * reached a state in this tracker.
 *
 * ## Ownership and access
 *
 * `owner_id` is the account that filed the application, and it is the only
 * thing that decides an applicant's access. `ON DELETE RESTRICT` mirrors the
 * rest of the schema: accounts are suspended, never hard-deleted, so a filing is
 * never orphaned.
 *
 * ## Shapes chosen for exactness
 *
 * `area_decimal` is `numeric(14, 4)` and the ownership share is a rational
 * numerator/denominator pair, exactly as on `parcels`. Neither is ever a float,
 * because an area or a share is an authoritative value. Both are optional here
 * because an applicant may not know them at filing time, and a missing value is
 * stored as nothing rather than as a zero that would look measured.
 *
 * `tracking_number` is assigned when an application is submitted, so it is
 * nullable and unique only among non-null values: a draft has no reference
 * number yet.
 *
 * `version` is the optimistic-concurrency token, bumped by the same database
 * trigger the other versioned tables use.
 */
export const applications = pgTable(
  'applications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    origin: dataOriginEnum('origin').notNull(),
    type: applicationTypeEnum('type').notNull(),
    status: applicationStatusEnum('status').notNull().default('draft'),
    /** Assigned on submission; null while the application is a draft. */
    trackingNumber: text('tracking_number'),
    district: text('district').notNull(),
    upazila: text('upazila').notNull(),
    mouza: text('mouza').notNull(),
    khatianNumber: text('khatian_number').notNull(),
    dagNumber: text('dag_number').notNull(),
    /** Optional: the applicant may not know the area when they file. */
    areaDecimal: numeric('area_decimal', { precision: 14, scale: 4 }),
    /** Optional rational share; null unless a share was supplied. */
    shareNumerator: integer('share_numerator'),
    shareDenominator: integer('share_denominator'),
    /**
     * The parcel this application concerns, when it names one the applicant can
     * see. Nullable because an application can be filed before a record exists
     * for the land, and optional for a certified-copy request.
     */
    parcelId: uuid('parcel_id').references(() => parcels.id, {
      onDelete: 'restrict',
    }),
    /**
     * The document checklist items the applicant declared they are supplying,
     * as codes. This is a declaration of what was listed, not evidence: an
     * uploaded file is a separate record, and nothing here claims a document was
     * verified.
     */
    declaredDocuments: jsonb('declared_documents')
      .notNull()
      .default(sql`'[]'::jsonb`),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    /** Set only for a settled application (`approved` or `rejected`). */
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    /**
     * What the reviewer recorded when settling. Never a statutory finding: it
     * explains a state in this tracker.
     */
    decisionNote: text('decision_note'),
    /** What happens next, for the states that wait on somebody. */
    nextStep: text('next_step'),
    deadline: timestamp('deadline', { withTimezone: true }),
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // A tracking number is a public reference, so it is unique where present.
    uniqueIndex('applications_tracking_number_unique')
      .on(table.trackingNumber)
      .where(sql`${table.trackingNumber} is not null`),
    index('applications_owner_idx').on(table.ownerId),
    index('applications_status_idx').on(table.status),
    index('applications_parcel_idx').on(table.parcelId),
    check('applications_version_positive', sql`${table.version} >= 1`),
    check(
      'applications_area_non_negative',
      sql`${table.areaDecimal} is null or ${table.areaDecimal} >= 0`,
    ),
    // A share is either fully absent or a valid rational: a numerator with no
    // denominator would be a value nobody can interpret.
    check(
      'applications_share_complete',
      sql`(${table.shareNumerator} is null) = (${table.shareDenominator} is null)`,
    ),
    check(
      'applications_share_non_negative',
      sql`${table.shareNumerator} is null or ${table.shareNumerator} >= 0`,
    ),
    check(
      'applications_share_denominator_positive',
      sql`${table.shareDenominator} is null or ${table.shareDenominator} > 0`,
    ),
    // The tracking number and the submission time appear together at
    // submission, so a settled-looking row can never lack its reference.
    check(
      'applications_tracking_number_matches_status',
      sql`(${table.status} = 'draft' and ${table.trackingNumber} is null)
          or (${table.status} <> 'draft' and ${table.trackingNumber} is not null)`,
    ),
    check(
      'applications_submitted_at_matches_status',
      sql`${table.status} = 'draft' or ${table.submittedAt} is not null`,
    ),
    check(
      'applications_decided_at_matches_status',
      sql`${table.decidedAt} is null
          or ${table.status} in ('approved', 'rejected')`,
    ),
  ],
)

export type Application = typeof applications.$inferSelect
export type NewApplication = typeof applications.$inferInsert
