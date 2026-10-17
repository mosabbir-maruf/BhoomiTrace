import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm'

import type { Database } from '../db/client.js'
import type {
  ProcessingJobKind,
  ProcessingJobStatus,
} from '../db/schema/enums.js'
import { processingJobs, type ProcessingJob } from '../db/schema/jobs.js'
import type { User } from '../db/schema/users.js'
import {
  ConflictError,
  IdempotencyKeyReusedError,
  JobLeaseLostError,
  NotFoundError,
  ServiceUnavailableError,
} from '../lib/errors.js'
import type { Page, PaginationQuery } from '../lib/pagination.js'
import { pageOf } from '../lib/pagination.js'
import { safeErrorSummary } from '../lib/redact.js'
import { AuditActions, recordAuditEvent } from './audit.js'

/**
 * A durable work queue built on PostgreSQL.
 *
 * Extraction is far too slow to run inside a request, so a request records a
 * job and returns; a separate worker process claims and runs it. Keeping the
 * queue in the same database as the data lets a claim and its result be one
 * transaction, and means a restart loses no queued work and no in-flight
 * bookkeeping. No additional broker is involved, and none is needed at this
 * scale.
 *
 * Four mechanisms make it safe to run several workers:
 *
 * - **`FOR UPDATE SKIP LOCKED`** makes claiming atomic: two workers cannot take
 *   the same row, and neither blocks the other.
 * - **A lease (`leased_until`)** is the crash recovery mechanism. A worker that
 *   dies leaves its lease to expire, after which the job is claimable again.
 *   Without a lease, a crash would strand a job in `processing` forever.
 * - **`attempt_count` against `max_attempts`** bounds retries, so a permanently
 *   broken job fails visibly instead of looping.
 * - **`available_at`** is the backoff clock, so a retry waits rather than
 *   hammering a failing dependency.
 *
 * `idempotency_key` makes repeated submissions safe. A second request with the
 * same key gets the job already created rather than a duplicate unit of work.
 * The key is scoped to the requester, so the promise it makes is "this *caller*
 * already asked for this" — never "somebody used this key". Two accounts may
 * choose the same key without seeing each other's job, and a key reused for a
 * different request is a `409` rather than a wrong answer.
 */

export interface JobView {
  id: string
  kind: ProcessingJobKind
  status: ProcessingJobStatus
  parcelId: string | null
  sourceDocumentId: string | null
  requestedBy: string | null
  idempotencyKey: string | null
  attemptCount: number
  maxAttempts: number
  availableAt: string
  leasedUntil: string | null
  lockedBy: string | null
  lastError: string | null
  payload: Record<string, unknown> | null
  result: Record<string, unknown> | null
  startedAt: string | null
  finishedAt: string | null
  createdAt: string
  updatedAt: string
}

export function toJobView(job: ProcessingJob): JobView {
  return {
    id: job.id,
    kind: job.kind,
    status: job.status,
    parcelId: job.parcelId,
    sourceDocumentId: job.sourceDocumentId,
    requestedBy: job.requestedBy,
    idempotencyKey: job.idempotencyKey,
    attemptCount: job.attemptCount,
    maxAttempts: job.maxAttempts,
    availableAt: job.availableAt.toISOString(),
    leasedUntil: job.leasedUntil?.toISOString() ?? null,
    lockedBy: job.lockedBy,
    lastError: job.lastError,
    payload: job.payload ?? null,
    result: job.result ?? null,
    startedAt: job.startedAt?.toISOString() ?? null,
    finishedAt: job.finishedAt?.toISOString() ?? null,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
  }
}

/** Statuses a job can still be cancelled from. */
const CANCELLABLE_STATUSES: readonly ProcessingJobStatus[] = [
  'queued',
  'retry_pending',
]

export interface EnqueueJobInput {
  /** Null for work the system schedules rather than a person. */
  requestedBy: string | null
  kind: ProcessingJobKind
  parcelId?: string | null
  sourceDocumentId?: string | null
  idempotencyKey?: string | null
  /** Non-sensitive inputs only. Validated against a per-kind schema by the route. */
  payload?: Record<string, unknown> | null
  maxAttempts: number
  actor:
    | { kind: 'user'; userId: string; role: User['role'] }
    | { kind: 'system'; system: string }
  requestId?: string | null
}

export interface EnqueueJobResult {
  job: JobView
  /** False when an existing job was returned for the same idempotency key. */
  created: boolean
}

/**
 * A stable text form of a value, for comparing two requests.
 *
 * Object keys are sorted recursively, so a payload that round-tripped through
 * `jsonb` — which does not preserve key order — still compares equal to the one
 * that produced it. Array order is preserved, because a list of requested fields
 * is a list, not a set.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))

  return `{${entries
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(',')}}`
}

/**
 * The identity of an enqueueing request: what a key actually stands for.
 *
 * A repeated key is only "the same request" when the kind, the target, and the
 * payload all match. Anything else is a different request reusing a key, which
 * is a client error rather than a lookup hit.
 */
function requestFingerprint(input: EnqueueJobInput): string {
  return canonicalJson({
    kind: input.kind,
    parcelId: input.parcelId ?? null,
    sourceDocumentId: input.sourceDocumentId ?? null,
    payload: input.payload ?? null,
  })
}

/** Finds the job a caller's key already produced, ignoring other requesters. */
async function loadJobByIdempotencyKey(
  executor: Pick<Database['orm'], 'select'>,
  key: string,
  requestedBy: string | null,
): Promise<ProcessingJob | undefined> {
  const rows = await executor
    .select()
    .from(processingJobs)
    .where(
      and(
        eq(processingJobs.idempotencyKey, key),
        requestedBy === null
          ? isNull(processingJobs.requestedBy)
          : eq(processingJobs.requestedBy, requestedBy),
      ),
    )
    .limit(1)

  return rows[0]
}

/** Refuses a key that already stands for a different request. */
function assertKeyHasSameMeaning(
  existing: ProcessingJob,
  input: EnqueueJobInput,
): void {
  const existingFingerprint = canonicalJson({
    kind: existing.kind,
    parcelId: existing.parcelId,
    sourceDocumentId: existing.sourceDocumentId,
    payload: existing.payload ?? null,
  })

  if (existingFingerprint !== requestFingerprint(input)) {
    throw new IdempotencyKeyReusedError(
      'That idempotency key was already used for a different request. Use a new key for a new unit of work.',
      { existingJobId: existing.id },
    )
  }
}

/**
 * Records a job, or returns the one this caller's key already produced.
 *
 * Two properties are load-bearing:
 *
 * - **The lookup is scoped to the requester.** The idempotency key is chosen by
 *   the client, so it cannot be trusted to be globally unique: if the lookup
 *   ignored the requester, one account could pick a key another account had
 *   used and be handed that account's job, including its result.
 * - **The insert, not a read-before-write, is what decides.** The partial unique
 *   index is scoped to the requester, so two simultaneous submissions by the
 *   same caller cannot both create a job, and two callers using the same key
 *   never conflict with each other at all.
 */
export async function enqueueJob(
  database: Database,
  input: EnqueueJobInput,
): Promise<EnqueueJobResult> {
  const idempotencyKey = input.idempotencyKey ?? null

  return database.orm.transaction(async (tx) => {
    // A read first only to answer quickly and to name the mismatch clearly; it
    // is not what makes the operation safe.
    if (idempotencyKey !== null) {
      const existing = await loadJobByIdempotencyKey(
        tx,
        idempotencyKey,
        input.requestedBy,
      )
      if (existing !== undefined) {
        assertKeyHasSameMeaning(existing, input)
        return { job: toJobView(existing), created: false }
      }
    }

    const inserted = await tx
      .insert(processingJobs)
      .values({
        kind: input.kind,
        status: 'queued',
        parcelId: input.parcelId ?? null,
        sourceDocumentId: input.sourceDocumentId ?? null,
        requestedBy: input.requestedBy,
        idempotencyKey,
        payload: input.payload ?? null,
        maxAttempts: input.maxAttempts,
      })
      // No conflict target: either partial unique index may be the one that
      // fires, and naming one of them would make the other a hard error.
      .onConflictDoNothing()
      .returning()

    const job = inserted[0]
    if (job === undefined) {
      // Lost a race with a concurrent submission by the *same* caller. The other
      // transaction has committed by the time this statement returns, so the row
      // is visible here.
      if (idempotencyKey === null) {
        throw new ServiceUnavailableError(
          'The work item could not be recorded. Try again.',
        )
      }

      const existing = await loadJobByIdempotencyKey(
        tx,
        idempotencyKey,
        input.requestedBy,
      )
      if (existing === undefined) {
        throw new ServiceUnavailableError(
          'The work item could not be recorded. Try again.',
        )
      }
      assertKeyHasSameMeaning(existing, input)
      return { job: toJobView(existing), created: false }
    }

    await recordAuditEvent(tx, {
      actor: input.actor,
      action: AuditActions.jobQueued,
      entityType: 'processing_job',
      entityId: job.id,
      summary: `Job queued: ${job.kind}.`,
      changes: {
        kind: job.kind,
        parcelId: job.parcelId,
        sourceDocumentId: job.sourceDocumentId,
        idempotencyKey: job.idempotencyKey,
      },
      requestId: input.requestId ?? null,
    })

    return { job: toJobView(job), created: true }
  })
}

export interface ClaimedJob {
  id: string
  kind: ProcessingJobKind
  parcelId: string | null
  sourceDocumentId: string | null
  requestedBy: string | null
  payload: Record<string, unknown> | null
  attemptCount: number
  maxAttempts: number
}

export interface ClaimOptions {
  workerId: string
  leaseSeconds: number
  /** Restrict to one kind, so a dedicated worker only sees its own work. */
  kind?: ProcessingJobKind
}

/**
 * Claims the oldest ready job, atomically.
 *
 * The candidate is chosen `FOR UPDATE SKIP LOCKED`, so a second worker skips a
 * row another worker is already holding instead of waiting or duplicating it.
 * The status change, attempt increment, and lease are written in the same
 * statement, so a claimed job is never left without a lease.
 *
 * ## Clock choice
 *
 * This is one autocommit statement, so `now()` (`transaction_timestamp()`) and
 * `clock_timestamp()` name the same instant. Readiness is tested with `now()`,
 * matching how `available_at` is scheduled, while the **lease deadline** is
 * written with `clock_timestamp()` so that it is defined by the same wall clock
 * that later validates it in `lockHeldJobRow`, `renewJobLease`, and
 * `recoverExpiredLeases`.
 *
 * @returns the claimed job, or `null` when nothing is ready.
 */
export async function claimNextJob(
  database: Database,
  options: ClaimOptions,
): Promise<ClaimedJob | null> {
  const kindCondition =
    options.kind === undefined
      ? sql`true`
      : sql`j.kind = ${options.kind}::processing_job_kind`

  const result = await database.orm.execute(sql`
    with candidate as (
      select j.id
      from processing_jobs j
      where j.status in ('queued', 'retry_pending')
        and j.available_at <= now()
        and ${kindCondition}
      order by j.available_at asc, j.created_at asc
      for update skip locked
      limit 1
    )
    update processing_jobs j
    set status = 'processing',
        attempt_count = j.attempt_count + 1,
        locked_by = ${options.workerId},
        leased_until = clock_timestamp() + (${options.leaseSeconds} * interval '1 second'),
        started_at = coalesce(j.started_at, clock_timestamp()),
        last_error = null
    from candidate c
    where j.id = c.id
    returning j.id, j.kind, j.parcel_id, j.source_document_id, j.requested_by,
              j.payload, j.attempt_count, j.max_attempts
  `)

  const row = result.rows[0]
  if (row === undefined) return null

  return {
    id: String(row['id']),
    kind: row['kind'] as ProcessingJobKind,
    parcelId: row['parcel_id'] === null ? null : String(row['parcel_id']),
    sourceDocumentId:
      row['source_document_id'] === null
        ? null
        : String(row['source_document_id']),
    requestedBy:
      row['requested_by'] === null ? null : String(row['requested_by']),
    payload: (row['payload'] as Record<string, unknown> | null) ?? null,
    attemptCount: Number(row['attempt_count']),
    maxAttempts: Number(row['max_attempts']),
  }
}

/** Identifies the worker holding a job, as a token to fence writes on. */
export interface JobFence {
  jobId: string
  workerId: string
}

/**
 * The result of trying to renew a lease.
 *
 * - `renewed` — the lease was extended.
 * - `not_held` — the job is still `processing` but is not held by this worker
 *   under a live lease (another worker owns it, or the lease has expired), so
 *   this worker has lost it.
 * - `settled` — the job is no longer `processing` at all: it already reached a
 *   terminal state, or recovery moved it on. There is nothing to renew, which is
 *   not a failure.
 */
export type LeaseRenewal = 'renewed' | 'not_held' | 'settled'

/**
 * Renews the lease on a job this worker still holds under a live lease.
 *
 * Long work outlives a fixed lease: a provider call, or a slow queue, can exceed
 * `WORKER_LEASE_SECONDS` while the worker is still alive and healthy. Without
 * renewal the lease would expire and a second worker would start the same job,
 * which is how one unit of work ends up with two sets of side effects.
 *
 * The update is guarded on four facts: the job identifier, this worker's
 * identifier, the `processing` state, and that the lease has **not already
 * expired**. The last one is load-bearing. Without it, a worker whose lease had
 * expired but had not yet been recovered could renew the lease back into
 * existence and write results onto a job that recovery is entitled to hand to
 * somebody else. Expiry is judged against `clock_timestamp()` rather than
 * `now()` for the reason given on `lockHeldJobRow`: a lease is a promise about
 * real time, and `now()` is frozen at transaction start.
 */
export async function renewJobLease(
  database: Database,
  options: { jobId: string; workerId: string; leaseSeconds: number },
): Promise<LeaseRenewal> {
  const renewed = await database.orm.execute(sql`
    update processing_jobs
    set leased_until = clock_timestamp() + (${options.leaseSeconds} * interval '1 second'),
        updated_at = clock_timestamp()
    where id = ${options.jobId}::uuid
      and locked_by = ${options.workerId}
      and status = 'processing'
      and leased_until is not null
      and leased_until > clock_timestamp()
    returning id
  `)

  if (renewed.rows.length > 0) return 'renewed'

  // Nothing was renewed. Say why, so the caller can tell "I lost the job" apart
  // from "the job is already finished, so stop renewing".
  const current = await database.orm.execute(sql`
    select status from processing_jobs where id = ${options.jobId}::uuid
  `)
  const row = current.rows[0]
  if (row === undefined) return 'not_held'
  return row['status'] === 'processing' ? 'not_held' : 'settled'
}

/** Minimal executor surface the fence check needs. */
export type JobFenceExecutor = Pick<Database['orm'], 'select'>

/**
 * The executor surface an atomic job write needs: reads under the row lock, the
 * terminal status update, and the audit insert.
 */
export type JobTransaction = Pick<
  Database['orm'],
  'select' | 'insert' | 'update'
>

export interface JobWriteOutcome {
  status: 'completed' | 'review_required'
  /** Non-sensitive output, e.g. identifiers of the rows produced. */
  result: Record<string, unknown>
}

/**
 * Locks a job row and confirms this worker may still write to it.
 *
 * This is the fence, and it is deliberately one statement that both takes the
 * row lock (`FOR UPDATE`) and evaluates the three facts that make a lease valid:
 * the row is `processing`, this worker is the holder, and the lease has not yet
 * expired. Doing all three under the lock is what makes the check and every
 * write that follows one atomic decision.
 *
 * ## Why the clock is `clock_timestamp()`, not `now()`
 *
 * A lease deadline is a promise about real time, so it is compared against the
 * wall clock. `now()` is `transaction_timestamp()`: it is frozen at the moment
 * the transaction began and would not move while a long write transaction ran,
 * so a lease that expired *during* the transaction would still look valid. The
 * wall clock answers the honest question — "is the lease valid right now?" — at
 * the instant the locked row is examined.
 *
 * @throws {NotFoundError} when no such job exists at all.
 * @throws {JobLeaseLostError} when the job is not held by this worker under a
 *   live lease, in which case the caller must write nothing.
 */
async function lockHeldJobRow(
  executor: JobFenceExecutor,
  fence: JobFence,
): Promise<ProcessingJob> {
  const rows = await executor
    .select({
      job: processingJobs,
      leaseHeld: sql<boolean>`${processingJobs.lockedBy} = ${fence.workerId}
        and ${processingJobs.status} = 'processing'
        and ${processingJobs.leasedUntil} is not null
        and ${processingJobs.leasedUntil} > clock_timestamp()`.as('lease_held'),
    })
    .from(processingJobs)
    .where(eq(processingJobs.id, fence.jobId))
    .limit(1)
    .for('update')

  const row = rows[0]
  if (row === undefined) {
    throw new NotFoundError('No job exists with that identifier.')
  }
  if (row.leaseHeld !== true) {
    throw new JobLeaseLostError(
      'This job is no longer held by this worker under a live lease, so its results were discarded.',
    )
  }

  return row.job
}

/**
 * Verifies the worker still holds the job under a live lease, at the moment side
 * effects commit.
 *
 * This is the fence. Checking only when the job is finalized is too late: by then
 * the extraction rows, findings, or report the stale worker produced have already
 * been written, and a second worker produces its own. Calling this as the first
 * statement inside the same transaction as those writes makes the ownership check
 * and the writes one atomic decision — if the job has moved on, or the lease has
 * expired, the whole transaction rolls back and nothing is duplicated.
 *
 * `FOR UPDATE` is deliberate. It takes the job row's lock for the whole
 * transaction, so a concurrent recovery or re-claim either happens strictly
 * before this check (and fails it) or strictly after this transaction commits
 * (and sees the result).
 */
export async function assertJobLeaseHeld(
  executor: JobFenceExecutor,
  fence: JobFence,
): Promise<void> {
  await lockHeldJobRow(executor, fence)
}

/**
 * Applies the terminal state of a finished job and records it, in the caller's
 * transaction.
 *
 * The status update and its audit row are written here together, so a job never
 * reaches a terminal state without a record of the worker that moved it there —
 * and, if the audit insert fails, the status update rolls back with it.
 */
async function applyTerminalState(
  tx: JobTransaction,
  fence: JobFence,
  outcome: JobWriteOutcome,
): Promise<void> {
  const updated = await tx
    .update(processingJobs)
    .set({
      status: outcome.status,
      result: outcome.result,
      leasedUntil: null,
      lockedBy: null,
      lastError: null,
      finishedAt: sql`clock_timestamp()`,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(processingJobs.id, fence.jobId),
        eq(processingJobs.lockedBy, fence.workerId),
        eq(processingJobs.status, 'processing'),
      ),
    )
    // The lease guard prevents a worker whose lease was already gone from
    // writing a result a newer worker is also producing.
    .returning()

  const job = updated[0]
  if (job === undefined) {
    throw new JobLeaseLostError(
      'This job is no longer held by this worker, so its result was not recorded.',
    )
  }

  await recordAuditEvent(tx, {
    actor: { kind: 'system', system: `worker:${fence.workerId}` },
    action:
      outcome.status === 'completed'
        ? AuditActions.jobCompleted
        : AuditActions.jobReviewRequired,
    entityType: 'processing_job',
    entityId: job.id,
    summary: `Job moved to ${outcome.status}.`,
    changes: {
      status: outcome.status,
      attemptCount: job.attemptCount,
      result: job.result,
      lastError: job.lastError,
    },
  })
}

/**
 * Runs a job's write half and finalizes the job, all in one transaction.
 *
 * ## The problem this closes
 *
 * Writing a job's side effects and marking the job done used to be two separate
 * transactions. A lease recovery could run in the gap between them: the domain
 * rows were committed, but the job was still `processing` with an expired lease,
 * so recovery requeued it and a second worker produced a *second* set of the same
 * side effects. Heartbeat timing alone cannot close that window, because "how
 * long the write takes" is not knowable in advance.
 *
 * ## The guarantee
 *
 * One transaction now holds, in this order:
 *
 * 1. `lockHeldJobRow` — takes the job row's `FOR UPDATE` lock and confirms the
 *    lease is still live. If the lease was already lost before this point, the
 *    transaction throws and **nothing** is written.
 * 2. `write(tx)` — the domain effects (readings, findings, or a report) together
 *    with their own audit rows.
 * 3. `applyTerminalState(tx, ...)` — the terminal status, the result payload,
 *    the lease release, and the terminal audit row.
 *
 * Because step 1 holds the row lock until the commit, a recovery racing the
 * finalization blocks on that lock; when it unblocks, PostgreSQL re-evaluates its
 * `where status = 'processing' and leased_until < now()` against the *committed*
 * row, which is no longer `processing`, so it does not requeue the job. No second
 * worker can have claimed the job either, because the row is locked. And because
 * everything is one transaction, a failure anywhere rolls back the domain effects
 * and the finalization together: there is no state in which a job's effects exist
 * but the job still looks `processing`.
 *
 * If the job has already been reclaimed by another worker, step 1 throws
 * `JobLeaseLostError` before any domain write, so a stale worker finalizes
 * nothing.
 */
export async function finalizeClaimedJob(
  database: Database,
  fence: JobFence,
  write: (tx: JobTransaction) => Promise<JobWriteOutcome>,
): Promise<JobWriteOutcome> {
  return database.orm.transaction(async (tx) => {
    await lockHeldJobRow(tx, fence)
    const outcome = await write(tx)
    await applyTerminalState(tx, fence, outcome)
    return outcome
  })
}

export interface FailJobOptions {
  jobId: string
  workerId: string
  error: unknown
  backoffSeconds: number
}

export interface FailJobOutcome {
  status: ProcessingJobStatus
  attemptCount: number
  maxAttempts: number
  nextAttemptAt: string | null
}

/**
 * Records a failed attempt, retrying with backoff until attempts are exhausted.
 *
 * Everything happens in one transaction, under the job row's lock: the row is
 * re-read `FOR UPDATE`, the live-lease guard is re-checked, the status change is
 * written, and the matching audit row is inserted. If writing the audit row
 * fails, the status change rolls back with it, so a failed attempt can never be
 * recorded without the event that explains it — or the event without the change.
 *
 * A failure may only be recorded by a worker that still holds a live lease. If
 * recovery has already taken the job over, this throws `JobLeaseLostError` and
 * writes nothing, rather than clobbering the recovered state.
 *
 * The stored error is a redacted, truncated summary: a raw provider payload or
 * document fragment must never end up in an operational record. Backoff doubles
 * per attempt, bounded at one hour, so a failing dependency is not hammered. The
 * next attempt time is computed from the database clock (`clock_timestamp()`),
 * so a worker's own clock cannot skew the queue.
 */
export async function failJobAttempt(
  database: Database,
  options: FailJobOptions,
): Promise<FailJobOutcome> {
  return database.orm.transaction(async (tx) => {
    const job = await lockHeldJobRow(tx, {
      jobId: options.jobId,
      workerId: options.workerId,
    })

    const exhausted = job.attemptCount >= job.maxAttempts
    const backoffSeconds = Math.min(
      3_600,
      options.backoffSeconds * 2 ** Math.max(0, job.attemptCount - 1),
    )
    const errorSummary = safeErrorSummary(options.error)

    const updated = await tx
      .update(processingJobs)
      .set({
        status: exhausted ? 'failed' : 'retry_pending',
        lastError: errorSummary,
        result: null,
        leasedUntil: null,
        lockedBy: null,
        updatedAt: sql`clock_timestamp()`,
        ...(exhausted
          ? { finishedAt: sql`clock_timestamp()` }
          : {
              availableAt: sql`clock_timestamp() + (${backoffSeconds} * interval '1 second')`,
            }),
      })
      .where(
        and(
          eq(processingJobs.id, options.jobId),
          eq(processingJobs.lockedBy, options.workerId),
          eq(processingJobs.status, 'processing'),
        ),
      )
      .returning({
        attemptCount: processingJobs.attemptCount,
        maxAttempts: processingJobs.maxAttempts,
        availableAt: processingJobs.availableAt,
      })

    const row = updated[0]
    if (row === undefined) {
      throw new JobLeaseLostError('The job failure could not be recorded.')
    }

    const nextAttemptAt = exhausted ? null : row.availableAt.toISOString()

    await recordAuditEvent(tx, {
      actor: { kind: 'system', system: `worker:${options.workerId}` },
      action: exhausted ? AuditActions.jobFailed : AuditActions.jobRetryScheduled,
      entityType: 'processing_job',
      entityId: options.jobId,
      summary: exhausted
        ? `Job failed permanently after ${row.attemptCount} attempt(s).`
        : `Job attempt ${row.attemptCount} failed; a retry is scheduled.`,
      changes: {
        attemptCount: row.attemptCount,
        maxAttempts: row.maxAttempts,
        exhausted,
        nextAttemptAt,
        error: errorSummary,
      },
    })

    return {
      status: exhausted ? 'failed' : 'retry_pending',
      attemptCount: row.attemptCount,
      maxAttempts: row.maxAttempts,
      nextAttemptAt,
    }
  })
}

export interface RecoveredLease {
  jobId: string
  outcome: 'retry_pending' | 'failed'
  /** The worker that held the lease when it expired, for the audit trail. */
  previousWorker: string | null
  attemptCount: number
  maxAttempts: number
}

/**
 * Recovers jobs whose worker died while holding them.
 *
 * A job in `processing` whose lease has expired was abandoned: the worker
 * crashed, was killed, or lost the database. It is returned to the queue if it
 * still has attempts left, and failed if it does not. This is what makes a
 * crashed worker a delay rather than a permanent stall.
 *
 * ## Locking and atomicity
 *
 * The expired rows are selected `FOR UPDATE` first, so recovery takes the same
 * row locks a finalizing worker holds. If a worker is in the middle of its
 * finalization transaction, recovery blocks on that lock; after the worker
 * commits, the re-check against the committed row finds it is no longer
 * `processing`, so it is left alone. This is precisely why recovery can never
 * requeue a job whose effects have already been committed. Only jobs still
 * `processing` under an expired lease are transitioned, each exactly once, so a
 * recovery racing a worker cannot produce a duplicate audit event either.
 *
 * The status change and one audit row per transitioned job are written in the
 * same transaction: if an audit insert fails, none of the transitions commit.
 * Expiry is judged against the wall clock (`clock_timestamp()`), because a lease
 * is a promise about real time.
 */
export async function recoverExpiredLeases(
  database: Database,
): Promise<RecoveredLease[]> {
  return database.orm.transaction(async (tx) => {
    const expired = await tx
      .select({
        id: processingJobs.id,
        lockedBy: processingJobs.lockedBy,
        attemptCount: processingJobs.attemptCount,
        maxAttempts: processingJobs.maxAttempts,
      })
      .from(processingJobs)
      .where(
        and(
          eq(processingJobs.status, 'processing'),
          sql`${processingJobs.leasedUntil} is not null
            and ${processingJobs.leasedUntil} < clock_timestamp()`,
        ),
      )
      .for('update')

    if (expired.length === 0) return []

    await tx
      .update(processingJobs)
      .set({
        status: sql`case
          when ${processingJobs.attemptCount} >= ${processingJobs.maxAttempts}
            then 'failed'::processing_job_status
          else 'retry_pending'::processing_job_status end`,
        lastError: 'The worker holding this job stopped responding.',
        lockedBy: null,
        leasedUntil: null,
        availableAt: sql`clock_timestamp()`,
        finishedAt: sql`case
          when ${processingJobs.attemptCount} >= ${processingJobs.maxAttempts}
            then clock_timestamp() else null end`,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        inArray(
          processingJobs.id,
          expired.map((row) => row.id),
        ),
      )

    const recovered: RecoveredLease[] = expired.map((row) => ({
      jobId: row.id,
      outcome: row.attemptCount >= row.maxAttempts ? 'failed' : 'retry_pending',
      previousWorker: row.lockedBy,
      attemptCount: row.attemptCount,
      maxAttempts: row.maxAttempts,
    }))

    for (const lease of recovered) {
      await recordAuditEvent(tx, {
        actor: { kind: 'system', system: 'worker-recovery' },
        action: AuditActions.jobLeaseRecovered,
        entityType: 'processing_job',
        entityId: lease.jobId,
        summary:
          lease.outcome === 'failed'
            ? `Job failed after its worker's lease expired, its attempts having been exhausted (${lease.attemptCount} of ${lease.maxAttempts}).`
            : `Job requeued after its worker's lease expired (attempt ${lease.attemptCount} of ${lease.maxAttempts}).`,
        changes: {
          outcome: lease.outcome,
          previousWorker: lease.previousWorker,
          attemptCount: lease.attemptCount,
          maxAttempts: lease.maxAttempts,
        },
      })
    }

    return recovered
  })
}

/** Cancels a job that has not been claimed yet. */
export async function cancelJob(
  database: Database,
  input: { user: User; jobId: string; requestId?: string | null },
): Promise<JobView> {
  const rows = await database.orm
    .select()
    .from(processingJobs)
    .where(
      and(
        eq(processingJobs.id, input.jobId),
        input.user.role === 'applicant'
          ? eq(processingJobs.requestedBy, input.user.id)
          : undefined,
      ),
    )
    .limit(1)

  const job = rows[0]
  if (job === undefined) {
    throw new NotFoundError('No job exists with that identifier.')
  }

  if (!CANCELLABLE_STATUSES.includes(job.status)) {
    throw new ConflictError(
      `A job that is ${job.status} cannot be cancelled. Only queued or awaiting-retry work can be cancelled.`,
    )
  }

  return database.orm.transaction(async (tx) => {
    const updated = await tx
      .update(processingJobs)
      .set({ status: 'cancelled', finishedAt: new Date(), lockedBy: null })
      .where(
        and(
          eq(processingJobs.id, input.jobId),
          inArray(processingJobs.status, [...CANCELLABLE_STATUSES]),
        ),
      )
      .returning()

    const cancelled = updated[0]
    if (cancelled === undefined) {
      throw new ConflictError(
        'The job was claimed while it was being cancelled. Reload it to see its current state.',
      )
    }

    await recordAuditEvent(tx, {
      actor: { kind: 'user', userId: input.user.id, role: input.user.role },
      action: AuditActions.jobCancelled,
      entityType: 'processing_job',
      entityId: cancelled.id,
      summary: 'Job cancelled before it was claimed.',
      changes: { previousStatus: job.status },
      requestId: input.requestId ?? null,
    })

    return toJobView(cancelled)
  })
}

/** Loads a job the caller is allowed to see. */
export async function loadVisibleJob(
  database: Database,
  user: User,
  jobId: string,
): Promise<JobView> {
  const rows = await database.orm
    .select()
    .from(processingJobs)
    .where(
      and(
        eq(processingJobs.id, jobId),
        user.role === 'applicant'
          ? eq(processingJobs.requestedBy, user.id)
          : undefined,
      ),
    )
    .limit(1)

  const job = rows[0]
  if (job === undefined) {
    throw new NotFoundError('No job exists with that identifier.')
  }
  return toJobView(job)
}

/** Lists jobs the caller may see, newest first. */
export async function listJobs(
  database: Database,
  input: {
    user: User
    status?: ProcessingJobStatus
    kind?: ProcessingJobKind
    pagination: PaginationQuery
  },
): Promise<Page<JobView>> {
  const where = and(
    input.user.role === 'applicant'
      ? eq(processingJobs.requestedBy, input.user.id)
      : undefined,
    input.status === undefined ? undefined : eq(processingJobs.status, input.status),
    input.kind === undefined ? undefined : eq(processingJobs.kind, input.kind),
  )

  const [rows, counted] = await Promise.all([
    database.orm
      .select()
      .from(processingJobs)
      .where(where)
      .orderBy(desc(processingJobs.createdAt))
      .limit(input.pagination.limit)
      .offset(input.pagination.offset),
    database.orm
      .select({ count: sql<number>`count(*)::int` })
      .from(processingJobs)
      .where(where),
  ])

  return pageOf(rows.map(toJobView), counted[0]?.count ?? 0, input.pagination)
}

/** Counts jobs by status. Used by the worker's startup log and tests. */
export async function jobStatusCounts(
  database: Database,
): Promise<Record<string, number>> {
  const rows = await database.orm
    .select({
      status: processingJobs.status,
      count: sql<number>`count(*)::int`,
    })
    .from(processingJobs)
    .groupBy(processingJobs.status)

  const counts: Record<string, number> = {}
  for (const row of rows) counts[row.status] = row.count
  return counts
}
