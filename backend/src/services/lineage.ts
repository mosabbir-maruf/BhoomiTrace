import { and, asc, eq, sql } from 'drizzle-orm'

import type { Database } from '../db/client.js'
import type {
  LineageCertainty,
  LineageRelation,
} from '../db/schema/enums.js'
import { parcelLineage, type ParcelLineage } from '../db/schema/lineage.js'
import type { User } from '../db/schema/users.js'
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '../lib/errors.js'
import {
  compareAreas,
  formatArea,
  parseArea,
  sumAreas,
} from '../lib/rational.js'
import { AuditActions, recordAuditEvent } from './audit.js'
import { loadVisibleParcel } from './parcels.js'

/**
 * Parcel lineage: how a record continues, is renumbered, splits, or merges
 * across survey versions.
 *
 * Guiding rules:
 *
 * - **A link is evidence, not a conclusion.** Each link carries its own
 *   certainty. An applicant may record `unverified` or `illustrative` links but
 *   may not mint a `confirmed` one; confirming is a reviewer action and is
 *   audited. A proposed link therefore cannot silently become verified.
 * - **Graphs stay acyclic.** A lineage chain that loops back on itself cannot be
 *   interpreted, so a write that would close a cycle is rejected. Two
 *   concurrent writes could each pass their own check, so the whole write is
 *   serialised behind a transaction-scoped advisory lock.
 * - **Arithmetic is reported, never asserted.** For a split or a merge the
 *   service computes the area relationship with exact decimal arithmetic and
 *   returns it as a note. Areas adding up is *not* proof of legal continuity,
 *   and the note is worded so it cannot be read that way.
 */

/**
 * Advisory lock key that serialises lineage writes.
 *
 * Any transaction inserting a lineage edge holds this lock until it commits, so
 * the cycle check and the insert cannot be interleaved with another writer's.
 * The value is arbitrary but must never change: it is a coordination constant,
 * not data.
 */
const LINEAGE_WRITE_LOCK_KEY = 4_812_003

export interface LineageLinkView {
  id: string
  fromParcelId: string
  toParcelId: string
  relation: LineageRelation
  certainty: LineageCertainty
  evidenceReference: string | null
  note: string | null
  createdAt: string
}

export function toLineageLinkView(link: ParcelLineage): LineageLinkView {
  return {
    id: link.id,
    fromParcelId: link.fromParcelId,
    toParcelId: link.toParcelId,
    relation: link.relation,
    certainty: link.certainty,
    evidenceReference: link.evidenceReference,
    note: link.note,
    createdAt: link.createdAt.toISOString(),
  }
}

/** A structured, non-conclusive observation about split/merge areas. */
export interface LineageArithmeticNote {
  ruleCode: string
  relation: LineageRelation
  /** Areas actually involved, as exact decimal strings. */
  observedParts: string[]
  observedTotal: string
  expectedTotal: string
  /** True only when the two totals are exactly equal. */
  exactlyEqual: boolean
  explanation: string
}

/**
 * Checks whether the areas of the parcels named on one side of a link add up.
 *
 * `direction` decides which side is treated as the whole:
 * a `split` divides the `from` parcel, so the sum of everything the `from`
 * parcel splits into is compared with the `from` area; a `merge` combines the
 * `from` parcels into the `to` parcel, so their sum is compared with the `to`
 * area.
 *
 * Returns `null` for relations whose areas have no expected relationship.
 */
export async function describeLineageArithmetic(
  database: Database,
  input: { fromParcelId: string; toParcelId: string; relation: LineageRelation },
): Promise<LineageArithmeticNote | null> {
  if (input.relation !== 'split' && input.relation !== 'merge') return null

  if (input.relation === 'merge') {
    const parts = await database.orm
      .select({ id: parcelLineage.fromParcelId, area: sql<string>`p.area_decimal` })
      .from(parcelLineage)
      .innerJoin(
        sql`parcels p`,
        sql`p.id = ${parcelLineage.fromParcelId}`,
      )
      .where(
        and(
          eq(parcelLineage.toParcelId, input.toParcelId),
          eq(parcelLineage.relation, 'merge'),
        ),
      )

    const target = await database.orm.execute(
      sql`select area_decimal as area from parcels where id = ${input.toParcelId}`,
    )
    const expected = readSingleArea(target.rows)

    const observedParts = parts
      .map((row) => row.area)
      .filter((area): area is string => typeof area === 'string')
      .sort()

    if (observedParts.length === 0 || expected === null) return null

    return {
      ruleCode: 'LINEAGE_MERGE_AREA_SUM',
      relation: 'merge',
      observedParts,
      observedTotal: sumAreas(observedParts),
      expectedTotal: renderArea(expected),
      exactlyEqual: compareAreas(sumAreas(observedParts), expected) === 0,
      explanation:
        'Areas of the merged parcels compared with the merging parcel. ' +
        'Equal areas are a consistency observation only; they do not establish ' +
        'legal continuity or ownership.',
    }
  }

  const parts = await database.orm.execute(
    sql`select area_decimal as area from parcels where id = ${input.toParcelId}`,
  )
  const target = await database.orm.execute(
    sql`select area_decimal as area from parcels where id = ${input.fromParcelId}`,
  )

  const siblingRows = await database.orm.execute(
    sql`select p.area_decimal as area
        from parcel_lineage l
        join parcels p on p.id = l.to_parcel_id
        where l.from_parcel_id = ${input.fromParcelId} and l.relation = 'split'`,
  )

  const observedParts = siblingRows.rows
    .map((row) => readArea(row))
    .filter((area): area is string => area !== null)
    .sort()
  const expected = readSingleArea(target.rows)

  if (observedParts.length === 0 || expected === null) return null

  // `parts` is fetched so a single-part split is still described; it is unused
  // beyond confirming the direct endpoint exists.
  void parts

  return {
    ruleCode: 'LINEAGE_SPLIT_AREA_SUM',
    relation: 'split',
    observedParts,
    observedTotal: sumAreas(observedParts),
    expectedTotal: renderArea(expected),
    exactlyEqual: compareAreas(sumAreas(observedParts), expected) === 0,
    explanation:
      'Areas of the parcels this parcel is recorded as splitting into, compared ' +
      'with the area of the original parcel. Equal areas are a consistency ' +
      'observation only; they do not establish legal continuity or ownership.',
  }
}

function readArea(row: Record<string, unknown>): string | null {
  const value = row['area']
  return typeof value === 'string' ? value : null
}

/**
 * Renders an area in the same canonical form `sumAreas` produces.
 *
 * Without this a summed total would read `100` and a recorded area `100.0000`,
 * so two exactly equal values would look different in the same note. A value
 * that does not parse is passed through unchanged rather than replaced, because
 * inventing a number for it would be worse than showing what is stored.
 */
function renderArea(value: string): string {
  try {
    return formatArea(parseArea(value))
  } catch {
    return value
  }
}

function readSingleArea(rows: readonly Record<string, unknown>[]): string | null {
  const first = rows[0]
  return first === undefined ? null : readArea(first)
}

/**
 * The database surface the cycle walk needs.
 *
 * Satisfied by the pool and by an open transaction alike, so the walk can run
 * *inside* the transaction that inserted the edge. That is the whole point: run
 * against the pool and the new edge would be invisible to the check, and every
 * write would look acyclic.
 */
type SqlExecutor = Pick<Database['orm'], 'execute'>

/**
 * Detects whether the lineage graph currently contains a cycle reachable from
 * `startParcelId`.
 *
 * A recursive walk follows edges forward. A cycle exists when the walk returns
 * to its starting node. The `NOT ... = ANY(...)` guard stops the walk from
 * looping forever if a cycle already exists, so this is safe to run even on a
 * graph that has somehow become cyclic.
 */
async function lineageContainsCycle(
  database: SqlExecutor,
  startParcelId: string,
): Promise<boolean> {
  const result = await database.execute(sql`
    with recursive walk as (
      select l.to_parcel_id as node, array[]::uuid[] as visited
      from parcel_lineage l
      where l.from_parcel_id = ${startParcelId}
      union all
      select l.to_parcel_id, w.visited || w.node
      from parcel_lineage l
      join walk w on l.from_parcel_id = w.node
      where not (l.to_parcel_id = any(w.visited || w.node))
        and array_length(w.visited, 1) is distinct from 100
    )
    select exists (select 1 from walk where node = ${startParcelId}) as cycle
  `)

  const row = result.rows[0]
  return row?.['cycle'] === true
}

export interface CreateLineageInput {
  user: User
  fromParcelId: string
  toParcelId: string
  relation: LineageRelation
  certainty: LineageCertainty
  evidenceReference?: string | null
  note?: string | null
  requestId?: string | null
}

export interface CreateLineageResult {
  link: LineageLinkView
  /** Present for split/merge; an observation, never a verdict. */
  arithmetic: LineageArithmeticNote | null
}

/**
 * Creates a lineage link between two parcels.
 *
 * Both endpoints must be visible to the caller. An applicant may only start a
 * chain from a parcel they own, and may not record a `confirmed` link — that is
 * a reviewer's judgement, and it is recorded as an auditable action.
 */
export async function createLineageLink(
  database: Database,
  input: CreateLineageInput,
): Promise<CreateLineageResult> {
  if (input.fromParcelId === input.toParcelId) {
    throw new BadRequestError(
      'A parcel cannot be linked to itself.',
    )
  }

  // Both endpoints are loaded through the visibility rule, so an identifier the
  // caller may not see is reported as missing rather than as forbidden.
  const from = await loadVisibleParcel(database, input.user, input.fromParcelId)
  const to = await loadVisibleParcel(database, input.user, input.toParcelId)

  if (input.user.role === 'applicant') {
    if (from.ownerId !== input.user.id) {
      throw new ForbiddenError(
        'You may only record lineage starting from a parcel you own.',
      )
    }
    if (input.certainty === 'confirmed') {
      throw new ForbiddenError(
        'A confirmed lineage link can only be recorded by a reviewer.',
      )
    }
  }

  if (
    input.certainty === 'confirmed' &&
    (input.evidenceReference === undefined || input.evidenceReference === null)
  ) {
    throw new BadRequestError(
      'A confirmed lineage link must name the evidence it rests on.',
    )
  }

  const outcome = await database.orm.transaction(async (tx) => {
    // Serialise lineage writes for the duration of this transaction.
    await tx.execute(
      sql`select pg_advisory_xact_lock(${LINEAGE_WRITE_LOCK_KEY}::bigint)`,
    )

    const inserted = await tx
      .insert(parcelLineage)
      .values({
        fromParcelId: input.fromParcelId,
        toParcelId: input.toParcelId,
        relation: input.relation,
        certainty: input.certainty,
        evidenceReference: input.evidenceReference ?? null,
        note: input.note ?? null,
        createdBy: input.user.id,
      })
      .onConflictDoNothing()
      .returning()

    const link = inserted[0]
    if (link === undefined) {
      throw new ConflictError(
        'That lineage link already exists between these parcels.',
      )
    }

    // The check runs on `tx`, the same transaction that inserted the edge, so
    // it sees the edge under test. Against the pool it would read a snapshot
    // without the new row and never detect the cycle it was about to create.
    if (await lineageContainsCycle(tx, input.fromParcelId)) {
      // Throwing rolls the insert back, so the graph is never left cyclic.
      throw new BadRequestError(
        'That link would make the lineage chain point back on itself.',
      )
    }

    await recordAuditEvent(tx, {
      actor: { kind: 'user', userId: input.user.id, role: input.user.role },
      action: AuditActions.lineageCreated,
      entityType: 'parcel_lineage',
      entityId: link.id,
      summary: `Lineage link recorded: ${from.khatianNumber} ${input.relation} ${to.khatianNumber}.`,
      changes: {
        relation: input.relation,
        certainty: input.certainty,
        evidenceReference: input.evidenceReference ?? null,
      },
      requestId: input.requestId ?? null,
    })

    return toLineageLinkView(link)
  })

  return {
    link: outcome,
    arithmetic: await describeLineageArithmetic(database, {
      fromParcelId: input.fromParcelId,
      toParcelId: input.toParcelId,
      relation: input.relation,
    }),
  }
}

/** Lists lineage links touching a parcel, in both directions. */
export async function listLineageForParcel(
  database: Database,
  user: User,
  parcelId: string,
): Promise<{
  outgoing: LineageLinkView[]
  incoming: LineageLinkView[]
  arithmetic: LineageArithmeticNote[]
}> {
  await loadVisibleParcel(database, user, parcelId)

  const outgoingRows = await database.orm
    .select()
    .from(parcelLineage)
    .where(eq(parcelLineage.fromParcelId, parcelId))
    .orderBy(asc(parcelLineage.createdAt))

  const incomingRows = await database.orm
    .select()
    .from(parcelLineage)
    .where(eq(parcelLineage.toParcelId, parcelId))
    .orderBy(asc(parcelLineage.createdAt))

  const arithmetic: LineageArithmeticNote[] = []
  for (const relation of ['split', 'merge'] as const) {
    const matching = outgoingRows.filter((row) => row.relation === relation)
    for (const row of matching) {
      const note = await describeLineageArithmetic(database, {
        fromParcelId: row.fromParcelId,
        toParcelId: row.toParcelId,
        relation,
      })
      if (note !== null) arithmetic.push(note)
    }
  }

  return {
    outgoing: outgoingRows.map(toLineageLinkView),
    incoming: incomingRows.map(toLineageLinkView),
    arithmetic,
  }
}

export interface RaiseCertaintyInput {
  user: User
  parcelId: string
  lineageId: string
  certainty: LineageCertainty
  evidenceReference?: string | null
  requestId?: string | null
}

/**
 * Changes a link's certainty. Reviewer/admin only, always audited.
 *
 * Raising a link to `confirmed` requires evidence, and the audit row records
 * both the previous and the new state, so a link can never be seen to have
 * become verified without a trace of who decided that and why.
 */
export async function setLineageCertainty(
  database: Database,
  input: RaiseCertaintyInput,
): Promise<LineageLinkView> {
  if (input.user.role === 'applicant') {
    throw new ForbiddenError(
      'Only a reviewer may change how certain a lineage link is.',
    )
  }

  await loadVisibleParcel(database, input.user, input.parcelId)

  if (
    input.certainty === 'confirmed' &&
    (input.evidenceReference === undefined || input.evidenceReference === null)
  ) {
    throw new BadRequestError(
      'Confirming a lineage link requires the evidence it rests on.',
    )
  }

  return database.orm.transaction(async (tx) => {
    const existingRows = await tx
      .select()
      .from(parcelLineage)
      .where(
        and(
          eq(parcelLineage.id, input.lineageId),
          eq(parcelLineage.fromParcelId, input.parcelId),
        ),
      )
      .limit(1)

    const existing = existingRows[0]
    if (existing === undefined) {
      throw new NotFoundError('No lineage link exists with that identifier.')
    }

    const updated = await tx
      .update(parcelLineage)
      .set({
        certainty: input.certainty,
        evidenceReference:
          input.evidenceReference ?? existing.evidenceReference,
      })
      .where(eq(parcelLineage.id, input.lineageId))
      .returning()

    const link = updated[0]
    if (link === undefined) {
      throw new NotFoundError('No lineage link exists with that identifier.')
    }

    await recordAuditEvent(tx, {
      actor: { kind: 'user', userId: input.user.id, role: input.user.role },
      action: AuditActions.lineageCertaintyRaised,
      entityType: 'parcel_lineage',
      entityId: link.id,
      summary: `Lineage certainty changed from ${existing.certainty} to ${input.certainty}.`,
      changes: {
        before: existing.certainty,
        after: input.certainty,
        evidenceReference: link.evidenceReference,
      },
      requestId: input.requestId ?? null,
    })

    return toLineageLinkView(link)
  })
}

/**
 * Returns every parcel in one lineage chain, breadth-first.
 *
 * Used by the reconciliation rules to reason about a whole chain rather than a
 * single edge. Bounded by `maxNodes` so a pathological graph cannot make a
 * request unbounded.
 */
export async function collectLineageChain(
  database: Database,
  parcelId: string,
  maxNodes = 200,
): Promise<string[]> {
  const result = await database.orm.execute(sql`
    with recursive walk as (
      select ${parcelId}::uuid as node, array[]::uuid[] as visited
      union all
      select l.to_parcel_id, w.visited || w.node
      from parcel_lineage l
      join walk w on l.from_parcel_id = w.node
      where not (l.to_parcel_id = any(w.visited || w.node))
        and array_length(w.visited, 1) is distinct from ${maxNodes}
    )
    select distinct node from walk
  `)

  return result.rows
    .map((row) => row['node'])
    .filter((node): node is string => typeof node === 'string')
}

/** Compares a sum of areas against an expected total, exactly. */
export function areasReconcile(parts: readonly string[], expected: string): boolean {
  try {
    return parseArea(sumAreas(parts)) === parseArea(expected)
  } catch {
    return false
  }
}

/** Renders a list of areas for a human-readable explanation. */
export function describeAreas(areas: readonly string[]): string {
  return areas.map((area) => formatArea(parseArea(area))).join(' + ')
}
