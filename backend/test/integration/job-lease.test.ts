import { randomUUID } from 'node:crypto'

import { and, eq, isNotNull, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { VALIDATION_RULES_VERSION } from '../../src/config/constants.js'
import { auditEvents } from '../../src/db/schema/audit.js'
import { extractions } from '../../src/db/schema/extractions.js'
import { findings } from '../../src/db/schema/findings.js'
import { processingJobs } from '../../src/db/schema/jobs.js'
import { readinessReports } from '../../src/db/schema/readiness.js'
import { MockExtractionProvider } from '../../src/extraction/mock-provider.js'
import { JobLeaseLostError } from '../../src/lib/errors.js'
import {
  assertJobLeaseHeld,
  finalizeClaimedJob,
  renewJobLease,
  type ClaimedJob,
  type JobWriteOutcome,
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
import { closeTestDatabase } from '../helpers/database.js'

/**
 * Job leases: renewal, expiry, fencing, and what a worker that lost its lease
 * may write.
 *
 * A lease exists to answer one question — "is this worker still the one that owns
 * this job, under a live lease?" — and that answer has to hold at the moment side
 * effects are written, not merely when the work began. These tests pin down four
 * things:
 *
 * 1. A running job renews its lease, so a slow job is not stolen from a healthy
 *    worker; and only the worker holding a *live* lease can renew it.
 * 2. A lease that has already expired cannot be renewed back into existence, and
 *    a worker whose lease has expired cannot pass the fence.
 * 3. A worker that has lost the lease writes nothing — the check and the write
 *    are one transaction, so a lost lease rolls the whole set of side effects
 *    back rather than leaving half of them behind. This holds for extraction,
 *    reconciliation, and readiness alike.
 * 4. When two workers genuinely race one job, exactly one set of side effects,
 *    and exactly one terminal audit event, are persisted.
 *
 * Most cases set the processing state directly, so a test asserts on the
 * behaviour it names rather than on the queue's global ordering. The race cases
 * drive real workers through the real claim path.
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

/**
 * Puts one specific job into the `processing` state for a named worker.
 *
 * This is what `claimNextJob` writes, applied to a job we choose rather than to
 * whichever job happens to be oldest, so the assertions in a test are about its
 * own fixture.
 */
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

/**
 * Moves a job's lease into the past without changing its owner or state.
 *
 * This is the state a worker leaves behind when it stops renewing — still
 * `processing`, still named in `locked_by` — before recovery has run. It is the
 * precise condition recovery acts on.
 */
async function expireLease(jobId: string): Promise<void> {
  await api.database.orm
    .update(processingJobs)
    .set({ leasedUntil: new Date(Date.now() - 60_000) })
    .where(eq(processingJobs.id, jobId))
}

/**
 * Hands a job to a different worker, as recovery would after a lease expiry.
 *
 * The original worker is left believing it still holds the job, which is exactly
 * the race the fence has to survive.
 */
async function reclaim(jobId: string, workerId: string): Promise<void> {
  await api.database.orm
    .update(processingJobs)
    .set({
      status: 'processing',
      lockedBy: workerId,
      leasedUntil: new Date(Date.now() + 60_000),
    })
    .where(eq(processingJobs.id, jobId))
}

/** Finalizes a claimed job the way the worker does: one atomic transaction. */
async function finishJob(
  jobId: string,
  workerId: string,
  result: Record<string, unknown> = {},
): Promise<JobWriteOutcome> {
  return finalizeClaimedJob(api.database, { jobId, workerId }, async () => ({
    status: 'completed',
    result,
  }))
}

/** Audit rows recorded against one job, optionally filtered to one action. */
async function auditEventsFor(
  jobId: string,
  action?: string,
): Promise<{ action: string; actorId: string | null }[]> {
  return api.database.orm
    .select({ action: auditEvents.action, actorId: auditEvents.actorId })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.entityType, 'processing_job'),
        eq(auditEvents.entityId, jobId),
        action === undefined ? undefined : eq(auditEvents.action, action),
      ),
    )
}

/** Enqueues a background job of any kind and returns its id. */
async function enqueueJob(
  kind: 'document_extraction' | 'parcel_reconciliation' | 'readiness_report',
  parcelId: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const response = await applicant.post(`${API}/jobs`, {
    kind,
    parcelId,
    ...extra,
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

/** Provider-produced readings for a parcel (a manual reading has no provider). */
async function readingsFor(
  parcelId: string,
): Promise<(typeof extractions.$inferSelect)[]> {
  return api.database.orm
    .select()
    .from(extractions)
    .where(and(eq(extractions.parcelId, parcelId), isNotNull(extractions.provider)))
}

/** Enqueues an extraction job and returns its id. */
async function enqueueExtraction(
  parcelId: string,
  sourceDocumentId: string,
  fields: string[],
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

/* -------------------------------------------------------------------------- */
/* Renewal                                                                     */
/* -------------------------------------------------------------------------- */

describe('renewJobLease', () => {
  it('extends the lease for the worker that holds it, and only that worker', async () => {
    const parcel = await createParcel(applicant)
    const document = await createDocument(applicant)
    const jobId = await enqueueExtraction(parcel.id, document.id, ['area'])

    await takeJob(jobId, 'worker-a', 600)

    const before = await loadJob(jobId)
    const beforeMs = before.leasedUntil?.getTime() ?? 0

    // A different worker id cannot extend somebody else's lease: the guard is on
    // `locked_by`, so a stale or foreign worker cannot keep a job alive.
    expect(
      await renewJobLease(api.database, {
        jobId,
        workerId: 'worker-b',
        leaseSeconds: 600,
      }),
    ).toBe('not_held')

    // A shorter renewal is still a renewal, and it visibly moves the expiry.
    expect(
      await renewJobLease(api.database, {
        jobId,
        workerId: 'worker-a',
        leaseSeconds: 1,
      }),
    ).toBe('renewed')

    const after = await loadJob(jobId)
    const afterMs = after.leasedUntil?.getTime() ?? 0
    expect(afterMs).toBeLessThan(beforeMs)
    expect(afterMs).toBeGreaterThan(Date.now() - 1_000)

    await finishJob(jobId, 'worker-a', { fieldCount: 0 })
  })

  it('refuses to renew a job that has already settled', async () => {
    const parcel = await createParcel(applicant)
    const document = await createDocument(applicant)
    const jobId = await enqueueExtraction(parcel.id, document.id, ['area'])

    await takeJob(jobId, 'worker-a')
    await finishJob(jobId, 'worker-a', { fieldCount: 0 })

    // No longer `processing`, so there is no lease to renew — and that is a
    // settled job, not a lost one.
    expect(
      await renewJobLease(api.database, {
        jobId,
        workerId: 'worker-a',
        leaseSeconds: 30,
      }),
    ).toBe('settled')
  })

  it('cannot resurrect a lease that has already expired', async () => {
    const parcel = await createParcel(applicant)
    const document = await createDocument(applicant)
    const jobId = await enqueueExtraction(parcel.id, document.id, ['area'])

    // A lease already in the past, with the job still marked `processing` — the
    // state a worker leaves behind when it stops renewing without being
    // recovered yet.
    await takeJob(jobId, 'worker-a')
    await expireLease(jobId)

    expect(
      await renewJobLease(api.database, {
        jobId,
        workerId: 'worker-a',
        leaseSeconds: 30,
      }),
    ).toBe('not_held')

    // The failed renewal wrote nothing: the lease is still expired, so recovery
    // still owns the job.
    const job = await loadJob(jobId)
    expect(job.status).toBe('processing')
    expect(job.lockedBy).toBe('worker-a')
    expect(job.leasedUntil?.getTime() ?? 0).toBeLessThan(Date.now())
  })
})

/* -------------------------------------------------------------------------- */
/* Fencing                                                                     */
/* -------------------------------------------------------------------------- */

describe('assertJobLeaseHeld', () => {
  it('accepts the worker that holds the job and rejects everybody else', async () => {
    const parcel = await createParcel(applicant)
    const document = await createDocument(applicant)
    const jobId = await enqueueExtraction(parcel.id, document.id, ['area'])

    await takeJob(jobId, 'holder')

    await expect(
      assertJobLeaseHeld(api.database.orm, { jobId, workerId: 'holder' }),
    ).resolves.toBeUndefined()

    await expect(
      assertJobLeaseHeld(api.database.orm, { jobId, workerId: 'other' }),
    ).rejects.toBeInstanceOf(JobLeaseLostError)

    await finishJob(jobId, 'holder', { fieldCount: 0 })
  })

  it('rejects the holder once the lease has expired', async () => {
    const parcel = await createParcel(applicant)
    const document = await createDocument(applicant)
    const jobId = await enqueueExtraction(parcel.id, document.id, ['area'])

    await takeJob(jobId, 'holder')
    await expireLease(jobId)

    // Ownership and state alone are not enough: the lease has to be live.
    await expect(
      assertJobLeaseHeld(api.database.orm, { jobId, workerId: 'holder' }),
    ).rejects.toBeInstanceOf(JobLeaseLostError)
  })
})

/* -------------------------------------------------------------------------- */
/* A worker that has lost its lease writes nothing                             */
/* -------------------------------------------------------------------------- */

describe('a worker that lost its lease', () => {
  it('cannot record side effects, and writes nothing at all', async () => {
    const parcel = await createParcel(applicant)
    const document = await createDocument(applicant)
    const jobId = await enqueueExtraction(parcel.id, document.id, ['khatian', 'area'])

    const claimed = await takeJob(jobId, 'worker-a')

    // The lease is taken away from worker A: recovery reassigns the job to
    // somebody else, exactly as it would after an expiry.
    await api.database.orm
      .update(processingJobs)
      .set({
        status: 'processing',
        lockedBy: 'worker-b',
        leasedUntil: new Date(Date.now() + 60_000),
      })
      .where(eq(processingJobs.id, jobId))

    // Worker A now tries to persist the reading it produced while it still
    // believed it held the job.
    const provider = new MockExtractionProvider({
      model: 'stale-worker',
      fixtures: {
        [document.id]: { khatian: { value: '104' }, area: { value: '125.0000' } },
      },
    })

    const outcome = await processClaimedJob(
      {
        database: api.database,
        provider,
        rulesVersion: VALIDATION_RULES_VERSION,
        fence: { jobId, workerId: 'worker-a' },
        uploadDir: api.uploadDir,
        maxContentBytes: 5 * 1024 * 1024,
        log: silentLogger,
      },
      claimed,
    ).catch((error: unknown) => error)

    // The write is refused loudly rather than silently skipped.
    expect(outcome).toBeInstanceOf(JobLeaseLostError)

    // And nothing of it survives: no reading, and the job still belongs to the
    // worker that actually holds it.
    expect(await readingsFor(parcel.id)).toEqual([])
    const stillHeld = await loadJob(jobId)
    expect(stillHeld.status).toBe('processing')
    expect(stillHeld.lockedBy).toBe('worker-b')
  })

  it('cannot record a failure either, because that is another write on the lease', async () => {
    const parcel = await createParcel(applicant)
    const document = await createDocument(applicant)
    const jobId = await enqueueExtraction(parcel.id, document.id, ['area'])

    await takeJob(jobId, 'worker-a')

    // A worker that is not the lease holder cannot finalize the job…
    await expect(
      finalizeClaimedJob(api.database, { jobId, workerId: 'worker-b' }, async () => ({
        status: 'completed',
        result: { note: 'not mine' },
      })),
    ).rejects.toBeInstanceOf(JobLeaseLostError)

    // …and the job is untouched by that attempt.
    const untouched = await loadJob(jobId)
    expect(untouched.status).toBe('processing')
    expect(untouched.result).toBeNull()
    expect(untouched.lockedBy).toBe('worker-a')

    // The holder can finalize it; a second finalization under the same lease
    // cannot, because the job is no longer `processing`.
    await expect(
      finishJob(jobId, 'worker-a', { note: 'mine' }),
    ).resolves.toMatchObject({ status: 'completed' })
    await expect(
      finishJob(jobId, 'worker-a', { note: 'again' }),
    ).rejects.toBeInstanceOf(JobLeaseLostError)
  })

  it('cannot persist reconciliation findings once the job is reclaimed', async () => {
    const parcel = await createParcel(applicant)
    // Retired, so the lifecycle rule definitely has a finding to raise.
    expectStatus(
      await applicant.post(`${API}/parcels/${parcel.id}/retire`, {
        version: parcel.version,
        reason: 'Superseded by a corrected filing.',
      }),
      200,
    )
    const jobId = await enqueueJob('parcel_reconciliation', parcel.id)
    const claimed = await takeJob(jobId, 'worker-a')
    await reclaim(jobId, 'worker-b')

    const outcome = await processClaimedJob(
      contextFor(jobId, 'worker-a'),
      claimed,
    ).catch((error: unknown) => error)

    expect(outcome).toBeInstanceOf(JobLeaseLostError)

    // No finding was raised by the stale worker, and the job is still worker B's.
    const findingsForParcel = await api.database.orm
      .select({ id: findings.id })
      .from(findings)
      .where(eq(findings.parcelId, parcel.id))
    expect(findingsForParcel).toEqual([])
    const stillHeld = await loadJob(jobId)
    expect(stillHeld.status).toBe('processing')
    expect(stillHeld.lockedBy).toBe('worker-b')
  })

  it('cannot persist a readiness report once the job is reclaimed', async () => {
    const parcel = await createParcel(applicant)
    const jobId = await enqueueJob('readiness_report', parcel.id)
    const claimed = await takeJob(jobId, 'worker-a')
    await reclaim(jobId, 'worker-b')

    const outcome = await processClaimedJob(
      contextFor(jobId, 'worker-a'),
      claimed,
    ).catch((error: unknown) => error)

    expect(outcome).toBeInstanceOf(JobLeaseLostError)

    const reports = await api.database.orm
      .select({ id: readinessReports.id })
      .from(readinessReports)
      .where(eq(readinessReports.parcelId, parcel.id))
    expect(reports).toEqual([])
    const stillHeld = await loadJob(jobId)
    expect(stillHeld.status).toBe('processing')
    expect(stillHeld.lockedBy).toBe('worker-b')
  })
})

/* -------------------------------------------------------------------------- */
/* Two workers, one set of side effects                                        */
/* -------------------------------------------------------------------------- */

describe('two workers racing one job', () => {
  it('leaves exactly one set of side effects, whichever worker wins', async () => {
    const parcel = await createParcel(applicant)
    const document = await createDocument(applicant)
    const jobId = await enqueueExtraction(parcel.id, document.id, ['khatian', 'area'])

    // A provider that takes long enough for a second worker to start while the
    // first is still reading — exactly the situation a fixed, too-short lease
    // would produce in production. Only calls naming this test's document are
    // counted and slowed: a worker drains the whole queue, and this suite shares
    // one database that accumulates rows across runs.
    let extractCalls = 0
    const inner = new MockExtractionProvider({
      model: 'slow-reader',
      fixtures: {
        [document.id]: { khatian: { value: '104' }, area: { value: '125.0000' } },
      },
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
          extractCalls += 1
          await new Promise((resolve) => setTimeout(resolve, 400))
        }
        return inner.extract(request)
      },
    }

    const workerOptions = {
      database: api.database,
      provider,
      rulesVersion: VALIDATION_RULES_VERSION,
      // A deliberately short lease. The heartbeat renews it, so a healthy but
      // slow worker is not robbed of its job.
      leaseSeconds: 1,
      maxAttempts: 3,
      retryBackoffSeconds: 0,
      pollIntervalMs: 10,
      uploadDir: api.uploadDir,
      maxContentBytes: 5 * 1024 * 1024,
      log: silentLogger,
    }

    const workerA = new ExtractionWorker({
      ...workerOptions,
      workerId: `race-a-${randomUUID().slice(0, 6)}`,
    })
    const workerB = new ExtractionWorker({
      ...workerOptions,
      workerId: `race-b-${randomUUID().slice(0, 6)}`,
    })

    const runningA = workerA.run()
    const runningB = workerB.run()

    const deadline = Date.now() + 20_000
    try {
      for (;;) {
        const job = await loadJob(jobId)
        if (job.status === 'completed' || job.status === 'review_required') break
        if (Date.now() > deadline) {
          throw new Error(`Job never settled; status was ${job.status}.`)
        }
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
    } finally {
      workerA.requestStop()
      workerB.requestStop()
      await Promise.all([runningA, runningB])
    }

    // One reading per field, not two: the fence means a second worker can never
    // duplicate the first worker's writes, however the race resolved.
    const readings = await readingsFor(parcel.id)
    expect(readings).toHaveLength(2)
    expect(new Set(readings.map((reading) => reading.field))).toEqual(
      new Set(['khatian', 'area']),
    )
    expect(readings.every((reading) => reading.providerModel === 'slow-reader')).toBe(true)

    const settled = await loadJob(jobId)
    expect(settled.status).toBe('completed')
    expect(settled.lockedBy).toBeNull()
    expect(settled.leasedUntil).toBeNull()
    // One attempt: the second worker never took the job from a worker that was
    // renewing its lease.
    expect(settled.attemptCount).toBe(1)
    expect(extractCalls).toBe(1)

    // Exactly one terminal transition, and exactly one audit row for it: the
    // winning worker finalized once, and the loser never finalized at all.
    expect(await auditEventsFor(jobId, 'job.completed')).toHaveLength(1)
    expect(await auditEventsFor(jobId, 'job.review_required')).toHaveLength(0)
    expect(await auditEventsFor(jobId, 'job.failed')).toHaveLength(0)
    expect(await auditEventsFor(jobId, 'job.retry_scheduled')).toHaveLength(0)
  })

  it('recovers a job whose worker stopped renewing, without duplicating readings', async () => {
    const parcel = await createParcel(applicant)
    const document = await createDocument(applicant)
    const jobId = await enqueueExtraction(parcel.id, document.id, ['area'])

    // A worker that claimed the job, produced nothing, and died: the lease has
    // expired but the row is still marked `processing`.
    await api.database.orm
      .update(processingJobs)
      .set({
        status: 'processing',
        attemptCount: 1,
        lockedBy: 'worker-that-died',
        leasedUntil: new Date(Date.now() - 60_000),
      })
      .where(eq(processingJobs.id, jobId))

    const worker = new ExtractionWorker({
      database: api.database,
      provider: new MockExtractionProvider({
        model: 'recovery-reader',
        fixtures: { [document.id]: { area: { value: '125.0000' } } },
      }),
      rulesVersion: VALIDATION_RULES_VERSION,
      workerId: `recovery-${randomUUID().slice(0, 6)}`,
      leaseSeconds: 5,
      maxAttempts: 3,
      retryBackoffSeconds: 0,
      pollIntervalMs: 10,
      uploadDir: api.uploadDir,
      maxContentBytes: 5 * 1024 * 1024,
      log: silentLogger,
    })

    const running = worker.run()
    const deadline = Date.now() + 15_000
    try {
      for (;;) {
        const job = await loadJob(jobId)
        if (job.status === 'completed' || job.status === 'review_required') break
        if (Date.now() > deadline) {
          throw new Error(`Job never settled; status was ${job.status}.`)
        }
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
    } finally {
      worker.requestStop()
      await running
    }

    const readings = await readingsFor(parcel.id)
    expect(readings).toHaveLength(1)
    expect(readings[0]?.recordedValue).toBe('125.0000')

    const settled = await loadJob(jobId)
    expect(settled.attemptCount).toBe(2)
    expect(settled.status).toBe('completed')
  })
})
