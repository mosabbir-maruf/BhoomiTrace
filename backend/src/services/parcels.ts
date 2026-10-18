import { and, asc, eq, ilike, sql, type SQL } from 'drizzle-orm'

import type { Database } from '../db/client.js'
import type { User } from '../db/schema/users.js'
import { parcelDags, parcels, type Parcel } from '../db/schema/parcels.js'
import type { SurveyVersion } from '../db/schema/enums.js'
import {
  ConcurrencyError,
  ForbiddenError,
  NotFoundError,
} from '../lib/errors.js'
import type { Page, PaginationQuery } from '../lib/pagination.js'
import { pageOf } from '../lib/pagination.js'
import { formatShare, parseShare } from '../lib/rational.js'
import { AuditActions, recordAuditEvent } from './audit.js'
import { requireExistingUser } from './users.js'

/**
 * Parcel records and their access rules.
 *
 * ## Ownership model
 *
 * A parcel has one `owner_id`. An **applicant** may see and change only parcels
 * they own; a parcel owned by somebody else is reported as *not found*, so that
 * guessing an identifier cannot reveal that a record exists. A **reviewer** may
 * read every parcel, because review work spans filings, but may not rewrite a
 * filing's core record — that is the owner's statement, and a reviewer's
 * disagreement is expressed as a review decision, not an edit. An **admin** may
 * read and change anything, including retirement.
 *
 * Synthetic demo parcels have no owner and are visible to reviewers and admins
 * only. They are never exposed to applicants, so an applicant's list contains
 * exactly their own filings.
 *
 * `origin` is returned on every parcel so a caller can always tell a demo
 * fixture from somebody's real record.
 */

export interface ParcelView {
  id: string
  ownerId: string | null
  origin: 'synthetic_demo' | 'user_created'
  lifecycle: 'active' | 'retired'
  survey: SurveyVersion
  khatianNumber: string
  mouza: string
  jlNumber: string
  upazila: string
  district: string
  /**
   * Recorded area in decimals, as an exact decimal string.
   *
   * A string, not a number: converting an authoritative area to an IEEE-754
   * double would silently lose exactness, which is unacceptable for a value
   * that comparisons and sums depend on.
   */
  areaDecimal: string
  /** Exact rational share, both as parts and as a `"n/d"` string. */
  shareNumerator: number
  shareDenominator: number
  ownershipShare: string
  dagNumbers: string[]
  version: number
  retirementReason: string | null
  retiredAt: string | null
  createdAt: string
  updatedAt: string
}

export function toParcelView(parcel: Parcel, dagNumbers: readonly string[]): ParcelView {
  return {
    id: parcel.id,
    ownerId: parcel.ownerId,
    origin: parcel.origin,
    lifecycle: parcel.lifecycle,
    survey: parcel.survey,
    khatianNumber: parcel.khatianNumber,
    mouza: parcel.mouza,
    jlNumber: parcel.jlNumber,
    upazila: parcel.upazila,
    district: parcel.district,
    areaDecimal: parcel.areaDecimal,
    shareNumerator: parcel.shareNumerator,
    shareDenominator: parcel.shareDenominator,
    // Rendered in lowest terms, matching how the validation rules render the
    // same share. The raw parts above stay exactly as filed; only the string
    // form is canonical, so "4/8" and "1/2" cannot look like two different
    // facts in two parts of one response.
    ownershipShare: formatShare(
      parseShare(`${parcel.shareNumerator}/${parcel.shareDenominator}`),
    ),
    dagNumbers: [...dagNumbers],
    version: parcel.version,
    retirementReason: parcel.retirementReason,
    retiredAt: parcel.retiredAt?.toISOString() ?? null,
    createdAt: parcel.createdAt.toISOString(),
    updatedAt: parcel.updatedAt.toISOString(),
  }
}

/** True when the user may read every parcel rather than only their own. */
export function hasGlobalParcelRead(user: User): boolean {
  return user.role === 'reviewer' || user.role === 'admin'
}

/** The extra `WHERE` clause an applicant's visibility requires. */
function ownershipFilter(user: User): SQL | undefined {
  return user.role === 'applicant' ? eq(parcels.ownerId, user.id) : undefined
}

async function loadDagNumbers(
  database: Database,
  parcelIds: readonly string[],
): Promise<Map<string, string[]>> {
  const grouped = new Map<string, string[]>()
  if (parcelIds.length === 0) return grouped

  const rows = await database.orm
    .select({ parcelId: parcelDags.parcelId, dagNumber: parcelDags.dagNumber })
    .from(parcelDags)
    .where(sql`${parcelDags.parcelId} = any(${sql.param(parcelIds)}::uuid[])`)
    .orderBy(asc(parcelDags.dagNumber))

  for (const row of rows) {
    const existing = grouped.get(row.parcelId)
    if (existing === undefined) grouped.set(row.parcelId, [row.dagNumber])
    else existing.push(row.dagNumber)
  }

  return grouped
}

export interface ParcelFilters {
  survey?: SurveyVersion
  district?: string
  upazila?: string
  mouza?: string
  khatianNumber?: string
  lifecycle?: 'active' | 'retired'
  origin?: 'synthetic_demo' | 'user_created'
}

export interface ListParcelsInput {
  user: User
  filters: ParcelFilters
  pagination: PaginationQuery
}

/** Lists parcels the user may see, with filters and bounded pagination. */
export async function listParcels(
  database: Database,
  input: ListParcelsInput,
): Promise<Page<ParcelView>> {
  const conditions: (SQL | undefined)[] = [ownershipFilter(input.user)]

  if (input.filters.survey !== undefined) {
    conditions.push(eq(parcels.survey, input.filters.survey))
  }
  if (input.filters.district !== undefined) {
    conditions.push(ilike(parcels.district, `%${input.filters.district}%`))
  }
  if (input.filters.upazila !== undefined) {
    conditions.push(ilike(parcels.upazila, `%${input.filters.upazila}%`))
  }
  if (input.filters.mouza !== undefined) {
    conditions.push(ilike(parcels.mouza, `%${input.filters.mouza}%`))
  }
  if (input.filters.khatianNumber !== undefined) {
    conditions.push(eq(parcels.khatianNumber, input.filters.khatianNumber))
  }
  if (input.filters.lifecycle !== undefined) {
    conditions.push(eq(parcels.lifecycle, input.filters.lifecycle))
  }
  if (input.filters.origin !== undefined) {
    conditions.push(eq(parcels.origin, input.filters.origin))
  }

  const where = and(...conditions.filter((entry): entry is SQL => entry !== undefined))

  const [rows, counted] = await Promise.all([
    database.orm
      .select()
      .from(parcels)
      .where(where)
      .orderBy(asc(parcels.createdAt), asc(parcels.id))
      .limit(input.pagination.limit)
      .offset(input.pagination.offset),
    database.orm
      .select({ count: sql<number>`count(*)::int` })
      .from(parcels)
      .where(where),
  ])

  const dags = await loadDagNumbers(
    database,
    rows.map((row) => row.id),
  )

  return pageOf(
    rows.map((row) => toParcelView(row, dags.get(row.id) ?? [])),
    counted[0]?.count ?? 0,
    input.pagination,
  )
}

/**
 * Loads a parcel the user is allowed to see.
 *
 * @throws {NotFoundError} when the parcel does not exist *or* is not visible to
 *   this user — the two cases are deliberately indistinguishable.
 */
export async function loadVisibleParcel(
  database: Database,
  user: User,
  parcelId: string,
): Promise<Parcel> {
  const rows = await database.orm
    .select()
    .from(parcels)
    .where(and(eq(parcels.id, parcelId), ownershipFilter(user)))
    .limit(1)

  const parcel = rows[0]
  if (parcel === undefined) {
    throw new NotFoundError('No parcel exists with that identifier.')
  }
  return parcel
}

/**
 * Loads one visible parcel and assembles its full view.
 *
 * A single-record read and a listing row go through the same `toParcelView`, so
 * the two can never disagree about how many DAG numbers a parcel has.
 */
export async function loadVisibleParcelView(
  database: Database,
  user: User,
  parcelId: string,
): Promise<ParcelView> {
  const parcel = await loadVisibleParcel(database, user, parcelId)

  const dags = await database.orm
    .select({ dagNumber: parcelDags.dagNumber })
    .from(parcelDags)
    .where(eq(parcelDags.parcelId, parcelId))
    .orderBy(asc(parcelDags.dagNumber))

  return toParcelView(parcel, dags.map((row) => row.dagNumber))
}

export interface CreateParcelInput {
  user: User
  survey: SurveyVersion
  khatianNumber: string
  mouza: string
  jlNumber: string
  upazila: string
  district: string
  areaDecimal: string
  shareNumerator: number
  shareDenominator: number
  dagNumbers: readonly string[]
  /** Only honoured for an admin; ignored for everybody else. */
  ownerId?: string | null
  requestId?: string | null
}

/**
 * Creates a parcel owned by the acting user.
 *
 * `origin` is always `user_created` here: the seeded demo dataset is written by
 * the seed, never through the API. `ownerId` in the request is ignored unless
 * the caller is an admin, so an applicant cannot file a record in somebody
 * else's name — and cannot even file one belonging to nobody.
 */
export async function createParcel(
  database: Database,
  input: CreateParcelInput,
): Promise<ParcelView> {
  // A filing is the applicant's own statement about their land. A reviewer's
  // business is to check filings, not to write them; an administrator may file
  // on somebody's behalf, which is the one case where `ownerId` is honoured.
  if (input.user.role === 'reviewer') {
    throw new ForbiddenError(
      'Reviewers do not create filings. Review the existing record instead.',
    )
  }

  const ownerId =
    input.user.role === 'admin' ? (input.ownerId ?? input.user.id) : input.user.id

  if (ownerId !== input.user.id) {
    await requireExistingUser(database, ownerId)
  }

  const dagNumbers = [...new Set(input.dagNumbers.map((dag) => dag.trim()))].filter(
    (dag) => dag.length > 0,
  )

  return database.orm.transaction(async (tx) => {
    const inserted = await tx
      .insert(parcels)
      .values({
        ownerId,
        origin: 'user_created',
        survey: input.survey,
        khatianNumber: input.khatianNumber.trim(),
        mouza: input.mouza.trim(),
        jlNumber: input.jlNumber.trim(),
        upazila: input.upazila.trim(),
        district: input.district.trim(),
        areaDecimal: input.areaDecimal,
        shareNumerator: input.shareNumerator,
        shareDenominator: input.shareDenominator,
      })
      .returning()

    const parcel = inserted[0]
    if (parcel === undefined) {
      throw new Error('Parcel insert did not return the created row.')
    }

    if (dagNumbers.length > 0) {
      await tx
        .insert(parcelDags)
        .values(dagNumbers.map((dagNumber) => ({ parcelId: parcel.id, dagNumber })))
    }

    await recordAuditEvent(tx, {
      actor: { kind: 'user', userId: input.user.id, role: input.user.role },
      action: AuditActions.parcelCreated,
      entityType: 'parcel',
      entityId: parcel.id,
      summary: 'Parcel record created.',
      changes: {
        survey: parcel.survey,
        khatianNumber: parcel.khatianNumber,
        mouza: parcel.mouza,
        areaDecimal: parcel.areaDecimal,
        origin: parcel.origin,
      },
      requestId: input.requestId ?? null,
    })

    // Read the DAG numbers back in the same order the read path uses, so a
    // freshly created record and a later fetch agree on the array.
    const dags = await tx
      .select({ dagNumber: parcelDags.dagNumber })
      .from(parcelDags)
      .where(eq(parcelDags.parcelId, parcel.id))
      .orderBy(asc(parcelDags.dagNumber))

    return toParcelView(parcel, dags.map((row) => row.dagNumber))
  })
}

export interface UpdateParcelInput {  user: User
  parcelId: string
  /** The version the caller read; a mismatch means somebody else got there first. */
  version: number
  areaDecimal?: string
  shareNumerator?: number
  shareDenominator?: number
  mouza?: string
  jlNumber?: string
  upazila?: string
  district?: string
  dagNumbers?: readonly string[]
  requestId?: string | null
}

/**
 * Updates a parcel's record fields under optimistic concurrency control.
 *
 * Only the owner (or an admin) may change a filing. A reviewer may read every
 * parcel but not rewrite one; if a reviewer disagrees with a recorded value,
 * the correct move is a review decision on the extraction, which leaves the
 * original value in place and adds history beside it.
 */
export async function updateParcel(
  database: Database,
  input: UpdateParcelInput,
): Promise<ParcelView> {
  const existing = await loadVisibleParcel(database, input.user, input.parcelId)

  if (input.user.role === 'applicant' && existing.ownerId !== input.user.id) {
    throw new NotFoundError('No parcel exists with that identifier.')
  }
  if (input.user.role === 'reviewer') {
    throw new ForbiddenError(
      'Reviewers do not rewrite a filing. Record a review decision instead.',
    )
  }

  return database.orm.transaction(async (tx) => {
    const updated = await tx
      .update(parcels)
      .set({
        ...(input.areaDecimal === undefined ? {} : { areaDecimal: input.areaDecimal }),
        ...(input.shareNumerator === undefined
          ? {}
          : { shareNumerator: input.shareNumerator }),
        ...(input.shareDenominator === undefined
          ? {}
          : { shareDenominator: input.shareDenominator }),
        ...(input.mouza === undefined ? {} : { mouza: input.mouza.trim() }),
        ...(input.jlNumber === undefined ? {} : { jlNumber: input.jlNumber.trim() }),
        ...(input.upazila === undefined ? {} : { upazila: input.upazila.trim() }),
        ...(input.district === undefined ? {} : { district: input.district.trim() }),
      })
      // The version guard is the concurrency control: the row is only written
      // if it still looks the way the caller last saw it.
      .where(and(eq(parcels.id, input.parcelId), eq(parcels.version, input.version)))
      .returning()

    const parcel = updated[0]
    if (parcel === undefined) {
      throw new ConcurrencyError(
        'This parcel was changed by somebody else. Reload it and try again.',
      )
    }

    if (input.dagNumbers !== undefined) {
      const dagNumbers = [...new Set(input.dagNumbers.map((dag) => dag.trim()))].filter(
        (dag) => dag.length > 0,
      )
      await tx.delete(parcelDags).where(eq(parcelDags.parcelId, parcel.id))
      if (dagNumbers.length > 0) {
        await tx
          .insert(parcelDags)
          .values(dagNumbers.map((dagNumber) => ({ parcelId: parcel.id, dagNumber })))
      }
    }

    const dags = await tx
      .select({ dagNumber: parcelDags.dagNumber })
      .from(parcelDags)
      .where(eq(parcelDags.parcelId, parcel.id))
      .orderBy(asc(parcelDags.dagNumber))

    await recordAuditEvent(tx, {
      actor: { kind: 'user', userId: input.user.id, role: input.user.role },
      action: AuditActions.parcelUpdated,
      entityType: 'parcel',
      entityId: parcel.id,
      summary: 'Parcel record updated.',
      changes: {
        before: {
          areaDecimal: existing.areaDecimal,
          shareNumerator: existing.shareNumerator,
          shareDenominator: existing.shareDenominator,
          district: existing.district,
          mouza: existing.mouza,
          version: existing.version,
        },
        after: {
          areaDecimal: parcel.areaDecimal,
          shareNumerator: parcel.shareNumerator,
          shareDenominator: parcel.shareDenominator,
          district: parcel.district,
          mouza: parcel.mouza,
          version: parcel.version,
        },
      },
      requestId: input.requestId ?? null,
    })

    return toParcelView(parcel, dags.map((dag) => dag.dagNumber))
  })
}

export interface LifecycleChangeInput {
  user: User
  parcelId: string
  version: number
  reason: string
  requestId?: string | null
}

/**
 * Retires or reinstates a parcel.
 *
 * This is the non-destructive counterpart to deletion. The parcel keeps its
 * evidence, lineage, findings, and review history; it simply stops appearing in
 * active work. Only an owner or an admin may retire; only an admin may
 * reinstate.
 */
export async function changeParcelLifecycle(
  database: Database,
  input: LifecycleChangeInput,
  target: 'active' | 'retired',
): Promise<ParcelView> {
  const existing = await loadVisibleParcel(database, input.user, input.parcelId)

  if (target === 'retired') {
    const isOwner = existing.ownerId === input.user.id
    if (input.user.role !== 'admin' && !isOwner) {
      throw new ForbiddenError('Only the owner or an administrator may retire a parcel.')
    }
  } else if (input.user.role !== 'admin') {
    throw new ForbiddenError('Only an administrator may reinstate a parcel.')
  }

  return database.orm.transaction(async (tx) => {
    const updated = await tx
      .update(parcels)
      .set(
        target === 'retired'
          ? {
              lifecycle: 'retired',
              retirementReason: input.reason,
              retiredAt: new Date(),
              retiredBy: input.user.id,
            }
          : {
              lifecycle: 'active',
              retirementReason: null,
              retiredAt: null,
              retiredBy: null,
            },
      )
      .where(and(eq(parcels.id, input.parcelId), eq(parcels.version, input.version)))
      .returning()

    const parcel = updated[0]
    if (parcel === undefined) {
      throw new ConcurrencyError(
        'This parcel was changed by somebody else. Reload it and try again.',
      )
    }

    await recordAuditEvent(tx, {
      actor: { kind: 'user', userId: input.user.id, role: input.user.role },
      action:
        target === 'retired' ? AuditActions.parcelRetired : AuditActions.parcelUpdated,
      entityType: 'parcel',
      entityId: parcel.id,
      summary:
        target === 'retired'
          ? `Parcel retired: ${input.reason}`
          : 'Parcel reinstated.',
      changes: { lifecycle: parcel.lifecycle, reason: input.reason },
      requestId: input.requestId ?? null,
    })

    const dags = await tx
      .select({ dagNumber: parcelDags.dagNumber })
      .from(parcelDags)
      .where(eq(parcelDags.parcelId, parcel.id))
      .orderBy(asc(parcelDags.dagNumber))

    return toParcelView(parcel, dags.map((dag) => dag.dagNumber))
  })
}
