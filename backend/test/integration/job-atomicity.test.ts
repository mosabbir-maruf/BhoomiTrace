import { randomUUID } from 'node:crypto'

import { and, eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { VALIDATION_RULES_VERSION } from '../../src/config/constants.js'
import { auditEvents } from '../../src/db/schema/audit.js'
import { extractions } from '../../src/db/schema/extractions.js'
import { findings } from '../../src/db/schema/findings.js'
import { processingJobs } from '../../src/db/schema/jobs.js'
import { MockExtractionProvider } from '../../src/extraction/mock-provider.js'
import { JobLeaseLostError } from '../../src/lib/errors.js'
import {
  failJobAttempt,
  finalizeClaimedJob,
  recoverExpiredLeases,
  type ClaimedJob,
} from '../../src/services/jobs.js'
import { ExtractionWorker } from '../../src/worker/runner.js'
import { processClaimedJob } from '../../src/worker/processor.js'
import {
  API,
  createAccount,
  createDocument,
  createParcel,
  createTestApi,
  expectStatus,
  signIn,
  type TestApi,
  type TestClient,
} from '../helpers/api.js'
import { closeTestDatabase, errorChainMessage } from '../helpers/database.js'

/**
 * Atomic job finalization: the window between a job's side effects and its
 * terminal state, and the audit trail that has to move with both.
 *
 * The failure these tests demonstrate is a *window*, not a happy path: a worker
 * writes its side effects, then something happens before the job is marked done,
 * and — because the job still looked `processing` under an expired lease — a
 * second worker produces the same effects again. The same shape applies to the
 * audit trail: a status change must never commit without the event that explains
 * it.
 *
 * Every test here forces the interleaving deterministically — a barrier or a
 * database-level fault injection rather than a race against a timer — and
 * asserts that the effects, the terminal status, and the audit row are
 * all-or-nothing. The one thing that cannot be made fully deterministic is a
 * *lease expiry*, which is a wall-clock fact, so a short bounded wait is used
 * where a test needs one.
 */

let api: TestApi
let applicant: TestClient

beforeAll(async () => {
  api = await createTestApi()
  applicant = await signIn(api.app, await createAccount(api.database, 'applicant'))
})

afterAll(async () => {
  await api.close()
  await closeTestDatabase()
})

const silentLogger = {
  info: (): void => undefined,
  warn: (): void => undefined,
  error: (): void => undefined,
}

/* -------------------------------------------------------------------------- */
/* Fixtures and helpers                                                        */
/* -------------------------------------------------------------------------- */

/** Puts one job into `processing` for a named worker, with a live lease. */
async function takeJob(
  jobId: string,
  workerId: string,
  leaseSeconds = 30,
): Promise<ClaimedJob> {
  const rows = await api.database.orm
    .update(processingJobs)
    .set({
      status: 'processing',
      attemptCount: sql`${processingJobs.attemptCount} + 1`,
      lockedBy: workerId,
      leasedUntil: new Date(Date.now() + leaseSeconds * 1_000),
      startedAt: new Date(),
    })
    .where(and(eq(processingJobs.id, jobId), eq(processingJobs.status, 'queued')))
    .returning()

  const job = rows[0]
  if (job === undefined) throw new Error(`Job ${jobId} was not queued.`)

  return {
    id: job.id,
    kind: job.kind,
    parcelId: job.parcelId,
    sourceDocumentId: job.sourceDocumentId,
    requestedBy: job.requestedBy,
    payload: job.payload,
    attemptCount: job.attemptCount,
    maxAttempts: job.maxAttempts,
  }
}

/** Marks a job as abandoned: `processing`, held by a worker, lease in the past. */
async function seedExpiredLease(
  jobId: string,
  workerId: string,
  attemptCount: number,
): Promise<void> {
  await api.database.orm
    .update(processingJobs)
    .set({
      status: 'processing',
      attemptCount,
      lockedBy: workerId,
      leasedUntil: new Date(Date.now() - 60_000),
    })
    .where(eq(processingJobs.id, jobId))
}

async function loadJob(jobId: string) {
  const rows = await api.database.orm
    .select()
    .from(processingJobs)
    .where(eq(processingJobs.id, jobId))
    .limit(1)
  const job = rows[0]
  if (job === undefined) throw new Error(`Job ${jobId} disappeared.`)
  return job
}

/** Audit rows recorded against one job, optionally filtered to one action. */
async function countAudit(jobId: string, action?: string): Promise<number> {
  const rows = await api.database.orm
    .select({ id: auditEvents.id })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.entityType, 'processing_job'),
        eq(auditEvents.entityId, jobId),
        action === undefined ? undefined : eq(auditEvents.action, action),
      ),
    )
  return rows.length
}

async function countExtractions(parcelId: string): Promise<number> {
  const rows = await api.database.orm
    .select({ id: extractions.id })
    .from(extractions)
    .where(eq(extractions.parcelId, parcelId))
  return rows.length
}

async function countProbeFindings(parcelId: string): Promise<number> {
  const rows = await api.database.orm
    .select({ id: findings.id })
    .from(findings)
    .where(
      and(
        eq(findings.parcelId, parcelId),
        eq(findings.ruleCode, 'ATOMICITY_PROBE'),
      ),
    )
  return rows.length
}

/** Enqueues an extraction job through the real API and returns its id. */
async function enqueueExtraction(
  parcelId: string,
  sourceDocumentId: string,
  fields: string[] = ['area'],
): Promise<string> {
  const response = await applicant.post(`${API}/jobs`, {
    kind: 'document_extraction',
    parcelId,
    sourceDocumentId,
    fields,
  })
  expectStatus(response, 202)
  return (response.json() as { id: string }).id
}

/** A processor context for one worker, mirroring what the runner builds. */
function contextFor(
  jobId: string,
  workerId: string,
  provider = new MockExtractionProvider(),
) {
  return {
    database: api.database,
    provider,
    rulesVersion: VALIDATION_RULES_VERSION,
    fence: { jobId, workerId },
    uploadDir: api.uploadDir,
    maxContentBytes: 5 * 1024 * 1024,
    log: silentLogger,
  }
}

/** Starts a worker and waits until the named job reaches a terminal state. */
async function runWorkerUntilSettled(
  jobId: string,
  provider: import('../../src/extraction/provider.js').ExtractionProvider,
  options: { maxAttempts?: number; retryBackoffSeconds?: number } = {},
) {
  const worker = new ExtractionWorker({
    database: api.database,
    provider,
    rulesVersion: VALIDATION_RULES_VERSION,
    workerId: `atomic-${randomUUID().slice(0, 8)}`,
    leaseSeconds: 30,
    maxAttempts: options.maxAttempts ?? 3,
    retryBackoffSeconds: options.retryBackoffSeconds ?? 0,
    pollIntervalMs: 20,
    uploadDir: api.uploadDir,
    maxContentBytes: 5 * 1024 * 1024,
    log: silentLogger,
  })

  const running = worker.run()
  const terminal = new Set(['completed', 'failed', 'review_required', 'cancelled'])
  const deadline = Date.now() + 20_000

  try {
    for (;;) {
      const job = await loadJob(jobId)
      if (terminal.has(job.status)) return job
      if (Date.now() > deadline) {
        throw new Error(`Job ${jobId} did not settle; last status was ${job.status}.`)
      }
      await new Promise((resolve) => setTimeout(resolve, 30))
    }
  } finally {
    worker.requestStop()
    await running
  }
}

interface Deferred {
  promise: Promise<void>
  resolve: () => void
}

function deferred(): Deferred {
  let resolve!: () => void
  const promise = new Promise<void>((inner) => {
    resolve = inner
  })
  return { promise, resolve }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/* -------------------------------------------------------------------------- */
/* Fault injection                                                             */
/* -------------------------------------------------------------------------- */

const FAILING_AUDIT_TRIGGER = 'bhoomitrace_test_fail_audit_trigger'
const FAILING_AUDIT_FUNCTION = 'bhoomitrace_test_fail_audit'

function assertSafeLiteral(value: string, pattern: RegExp): string {
  if (!pattern.test(value)) {
    throw new Error(`Refusing to inline an unexpected identifier: ${value}`)
  }
  return value
}

/**
 * Makes `audit_events` inserts for one job (optionally for one action) fail.
 *
 * This is how a test proves that the change an audit row describes rolls back
 * with the audit row: the insert is made to fail at the database, on the real
 * code path, rather than by stubbing the application.
 *
 * The trigger is scoped by `entity_id`, so it can only affect the fixture the
 * test names, and it is dropped again in a `finally`. The append-only guard on
 * `audit_events` (which rejects `UPDATE`/`DELETE`) is untouched: this adds a
 * `BEFORE INSERT` trigger, it does not remove the guard.
 *
 * The identifiers and the job id are inlined rather than passed as parameters,
 * because PostgreSQL does not accept parameter placeholders in a `CREATE
 * TRIGGER` statement. Each value is validated first.
 */
async function installFailingAuditTrigger(
  jobId: string,
  action?: string,
): Promise<void> {
  await dropFailingAuditTrigger()

  const idLiteral = assertSafeLiteral(
    jobId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  )
  const actionClause =
    action === undefined
      ? 'true'
      : `new.action = '${assertSafeLiteral(action, /^[a-z_.]+$/)}'`

  await api.database.orm.execute(sql`
    create function ${sql.raw(FAILING_AUDIT_FUNCTION)}() returns trigger
    language plpgsql as $function$
    begin
      raise exception 'audit insert forced to fail';
    end
    $function$;
  `)

  await api.database.orm.execute(sql`
    create trigger ${sql.raw(FAILING_AUDIT_TRIGGER)}
    before insert on audit_events
    for each row
    when (
      new.entity_type = 'processing_job'
      and new.entity_id = '${sql.raw(idLiteral)}'
      and ${sql.raw(actionClause)}
    )
    execute function ${sql.raw(FAILING_AUDIT_FUNCTION)}();
  `)
}

async function dropFailingAuditTrigger(): Promise<void> {
  await api.database.orm.execute(
    sql`drop trigger if exists ${sql.raw(FAILING_AUDIT_TRIGGER)} on audit_events`,
  )
  await api.database.orm.execute(
    sql`drop function if exists ${sql.raw(FAILING_AUDIT_FUNCTION)}()`,
  )
}

/* -------------------------------------------------------------------------- */
/* 1. Effects, finalization, and audit commit as one unit                      */
/* -------------------------------------------------------------------------- */

describe('atomic finalization', () => {
  it('commits effects and finalization together, so recovery cannot requeue them', async () => {
    const parcel = await createParcel(applicant)
    const document = await createDocument(applicant)
    const jobId = await enqueueExtraction(parcel.id, document.id)

    // A deliberately short lease. It will expire while the finalization
    // transaction is still open, which is the exact window that used to let
    // recovery requeue a job whose effects were already committed.
    await takeJob(jobId, 'worker-barrier', 0.3)

    const entered = deferred()
    const release = deferred()

    const finalizing = finalizeClaimedJob(
      api.database,
      { jobId, workerId: 'worker-barrier' },
      async (tx) => {
        // A real domain effect, written on the same transaction as the job's
        // terminal status.
        await tx.insert(findings).values({
          parcelId: parcel.id,
          kind: 'other',
          severity: 'info',
          status: 'open',
          title: 'atomicity probe',
          explanation: 'Written inside the finalization transaction.',
          ruleCode: 'ATOMICITY_PROBE',
        })

        entered.resolve()
        await release.promise
        return { status: 'completed', result: { probe: true } }
      },
    )

    await entered.promise

    // Past the lease expiry, so recovery would act on this row — except that the
    // finalization holds its row lock. Let recovery reach the lock and block.
    await sleep(500)
    const recovering = recoverExpiredLeases(api.database)
    await sleep(150)
    release.resolve()

    const outcome = await finalizing
    const recovered = await recovering

    expect(outcome.status).toBe('completed')

    // Recovery found this job only after the commit, by which point it was no
    // longer `processing`, so it did not requeue it.
    expect(recovered.map((lease) => lease.jobId)).not.toContain(jobId)

    const job = await loadJob(jobId)
    expect(job.status).toBe('completed')
    expect(job.lockedBy).toBeNull()
    expect(job.leasedUntil).toBeNull()

    // Exactly one set of effects and exactly one terminal event: the commit was
    // all-or-nothing, and it happened once.
    expect(await countProbeFindings(parcel.id)).toBe(1)
    expect(await countAudit(jobId, 'job.completed')).toBe(1)
    expect(await countAudit(jobId, 'job.lease_recovered')).toBe(0)
    expect(await countAudit(jobId, 'job.retry_scheduled')).toBe(0)
  })

  it('writes nothing when the lease is already gone before the transaction starts', async () => {
    const parcel = await createParcel(applicant)
    const document = await createDocument(applicant)
    const jobId = await enqueueExtraction(parcel.id, document.id)

    await takeJob(jobId, 'worker-a')
    // Reclaimed by another worker, as recovery would do after an expiry.
    await api.database.orm
      .update(processingJobs)
      .set({ lockedBy: 'worker-b', leasedUntil: new Date(Date.now() + 60_000) })
      .where(eq(processingJobs.id, jobId))

    const failure = await finalizeClaimedJob(
      api.database,
      { jobId, workerId: 'worker-a' },
      async (tx) => {
        // This must never run: the fence throws first.
        await tx.insert(findings).values({
          parcelId: parcel.id,
          kind: 'other',
          title: 'should not exist',
          explanation: 'Written by a worker that lost its lease.',
          ruleCode: 'ATOMICITY_PROBE',
        })
        return { status: 'completed', result: {} }
      },
    ).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(JobLeaseLostError)
    expect(await countProbeFindings(parcel.id)).toBe(0)
    const job = await loadJob(jobId)
    expect(job.status).toBe('processing')
    expect(job.lockedBy).toBe('worker-b')
  })
})

/* -------------------------------------------------------------------------- */
/* 2. An audit-write failure rolls the change back with it                     */
/* -------------------------------------------------------------------------- */

describe('audit atomicity', () => {
  it('rolls back the job state and the effects when the audit row cannot be written', async () => {
    const parcel = await createParcel(applicant)
    const document = await createDocument(applicant)
    const jobId = await enqueueExtraction(parcel.id, document.id)
    const claimed = await takeJob(jobId, 'worker-audit-fail')

    const provider = new MockExtractionProvider({
      model: 'audit-fail-reader',
      fixtures: { [document.id]: { area: { value: '125.0000' } } },
    })

    await installFailingAuditTrigger(jobId)
    let failure: unknown
    try {
      failure = await processClaimedJob(
        contextFor(jobId, 'worker-audit-fail', provider),
        claimed,
      ).catch((error: unknown) => error)
    } finally {
      await dropFailingAuditTrigger()
    }

    expect(errorChainMessage(failure)).toContain('audit insert forced to fail')

    // The whole transaction rolled back: no reading, and the job is still the
    // worker's, still `processing`, with no result and no terminal event.
    expect(await countExtractions(parcel.id)).toBe(0)
    const job = await loadJob(jobId)
    expect(job.status).toBe('processing')
    expect(job.lockedBy).toBe('worker-audit-fail')
    expect(job.result).toBeNull()
    expect(await countAudit(jobId, 'job.completed')).toBe(0)
  })

  it('rolls back a retry transition when its audit row cannot be written', async () => {
    const parcel = await createParcel(applicant)
    const document = await createDocument(applicant)
    const jobId = await enqueueExtraction(parcel.id, document.id)
    await takeJob(jobId, 'worker-fail-audit')

    await installFailingAuditTrigger(jobId, 'job.retry_scheduled')
    let failure: unknown
    try {
      failure = await failJobAttempt(api.database, {
        jobId,
        workerId: 'worker-fail-audit',
        error: new Error('the provider could not be reached'),
        backoffSeconds: 0,
      }).catch((error: unknown) => error)
    } finally {
      await dropFailingAuditTrigger()
    }

    expect(errorChainMessage(failure)).toContain('audit insert forced to fail')

    // No transition committed without its event, and no event without its
    // transition: the job is exactly where it was.
    const job = await loadJob(jobId)
    expect(job.status).toBe('processing')
    expect(job.lockedBy).toBe('worker-fail-audit')
    expect(job.lastError).toBeNull()
    expect(await countAudit(jobId, 'job.retry_scheduled')).toBe(0)
    expect(await countAudit(jobId, 'job.failed')).toBe(0)
  })
})

/* -------------------------------------------------------------------------- */
/* 3. Recovery: one event per transitioned job, atomically                     */
/* -------------------------------------------------------------------------- */

describe('expired-lease recovery', () => {
  it('writes one audit event per recovered job, and none if any event fails', async () => {
    const parcel = await createParcel(applicant)
    const document = await createDocument(applicant)

    // Three abandoned jobs: two with attempts left, one exhausted.
    const jobRetryA = await enqueueExtraction(parcel.id, document.id)
    const jobRetryB = await enqueueExtraction(parcel.id, document.id)
    const jobFailed = await enqueueExtraction(parcel.id, document.id)
    await seedExpiredLease(jobRetryA, 'worker-dead-a', 1)
    await seedExpiredLease(jobRetryB, 'worker-dead-b', 1)
    await seedExpiredLease(jobFailed, 'worker-dead-c', 3)

    const mine = [jobRetryA, jobRetryB, jobFailed]

    // A fault injected for one job must roll the whole recovery back: the audit
    // rows and the transitions share one transaction.
    await installFailingAuditTrigger(jobRetryB, 'job.lease_recovered')
    let aborted: unknown
    try {
      aborted = await recoverExpiredLeases(api.database).catch(
        (error: unknown) => error,
      )
    } finally {
      await dropFailingAuditTrigger()
    }

    expect(errorChainMessage(aborted)).toContain('audit insert forced to fail')
    for (const jobId of mine) {
      const job = await loadJob(jobId)
      expect(job.status).toBe('processing')
      expect(job.lockedBy).not.toBeNull()
      expect(await countAudit(jobId, 'job.lease_recovered')).toBe(0)
    }

    // Without the fault, each job transitions exactly once, and each transition
    // has exactly one audit event.
    const recovered = await recoverExpiredLeases(api.database)
    const recoveredIds = recovered.map((lease) => lease.jobId)
    expect(recoveredIds).toEqual(expect.arrayContaining(mine))
    expect(recovered.find((lease) => lease.jobId === jobFailed)?.outcome).toBe(
      'failed',
    )
    expect(recovered.find((lease) => lease.jobId === jobRetryA)?.outcome).toBe(
      'retry_pending',
    )

    for (const jobId of mine) {
      expect(await countAudit(jobId, 'job.lease_recovered')).toBe(1)
    }
    expect((await loadJob(jobFailed)).status).toBe('failed')
    expect((await loadJob(jobRetryA)).status).toBe('retry_pending')

    // Recovery is idempotent once the jobs have moved on: a second pass does not
    // touch them again, so there is no duplicate event.
    const second = await recoverExpiredLeases(api.database)
    expect(second.map((lease) => lease.jobId)).not.toContain(jobRetryA)
    expect(second.map((lease) => lease.jobId)).not.toContain(jobFailed)
    for (const jobId of mine) {
      expect(await countAudit(jobId, 'job.lease_recovered')).toBe(1)
    }
  })
})

/* -------------------------------------------------------------------------- */
/* 4. A failed/retried attempt leaves no effects and a consistent trail        */
/* -------------------------------------------------------------------------- */

describe('a retried attempt', () => {
  it('leaves no domain effects and exactly one event per transition', async () => {
    const parcel = await createParcel(applicant)
    const document = await createDocument(applicant)
    const jobId = await enqueueExtraction(parcel.id, document.id)

    // A small, exact attempt budget for this job. The budget that matters is the
    // one on the job row, not the worker option.
    await api.database.orm
      .update(processingJobs)
      .set({ maxAttempts: 2 })
      .where(eq(processingJobs.id, jobId))

    // Only this job's document fails; unrelated queued work the worker happens
    // to drain is unaffected, so the assertions stay about this fixture.
    const inner = new MockExtractionProvider({
      fixtures: { [document.id]: { area: { value: '125.0000' } } },
    })
    const provider = {
      name: inner.name,
      model: inner.model,
      requiresCredentials: inner.requiresCredentials,
      readsDocumentContent: inner.readsDocumentContent,
      supportedMediaTypes: inner.supportedMediaTypes,
      isConfigured: () => true,
      extract: async (request: Parameters<typeof inner.extract>[0]) => {
        if (request.sourceDocumentId === document.id) {
          throw new Error('the provider could not be reached')
        }
        return inner.extract(request)
      },
    }

    const settled = await runWorkerUntilSettled(jobId, provider, {
      maxAttempts: 2,
      retryBackoffSeconds: 0,
    })

    expect(settled.status).toBe('failed')
    expect(settled.attemptCount).toBe(2)
    expect(settled.finishedAt).not.toBeNull()

    // A failing attempt invents no reading.
    expect(await countExtractions(parcel.id)).toBe(0)

    // One event per transition, and nothing else: one scheduled retry, one
    // permanent failure, and no terminal event from the first attempt.
    expect(await countAudit(jobId, 'job.retry_scheduled')).toBe(1)
    expect(await countAudit(jobId, 'job.failed')).toBe(1)
    expect(await countAudit(jobId, 'job.completed')).toBe(0)
    expect(await countAudit(jobId, 'job.review_required')).toBe(0)
    expect(await countAudit(jobId, 'job.lease_recovered')).toBe(0)
  })
})
