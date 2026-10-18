import { randomUUID } from 'node:crypto'

import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { VALIDATION_RULES_VERSION } from '../../src/config/constants.js'
import { processingJobs } from '../../src/db/schema/jobs.js'
import type { ExtractionProvider } from '../../src/extraction/provider.js'
import { MockExtractionProvider } from '../../src/extraction/mock-provider.js'
import { ExtractionWorker } from '../../src/worker/runner.js'
import {
  API,
  createAccount,
  createDocument,
  createParcel,
  createTestApi,
  expectError,
  expectStatus,
  signIn,
  uniqueIdempotencyKey,
  type TestApi,
  type TestClient,
} from '../helpers/api.js'
import { closeTestDatabase } from '../helpers/database.js'

/**
 * The durable job queue and the worker that drains it.
 *
 * The queue exists so that a slow extraction never runs inside a request. What
 * is asserted here is the contract that makes it safe: a job is recorded before
 * any work starts, a claim is exclusive, a failure is retried a bounded number
 * of times and then given up on, an abandoned lease is recovered rather than
 * lost, and an unreadable result is a normal outcome that needs a person.
 *
 * Every assertion about worker behaviour is made against a real
 * `ExtractionWorker` running against the test database, driving an injectable
 * provider. No external model is contacted.
 */

let api: TestApi
let applicant: TestClient
let otherApplicant: TestClient
let reviewer: TestClient
let admin: TestClient

beforeAll(async () => {
  api = await createTestApi()

  applicant = await signIn(api.app, await createAccount(api.database, 'applicant'))
  otherApplicant = await signIn(api.app, await createAccount(api.database, 'applicant'))
  reviewer = await signIn(api.app, await createAccount(api.database, 'reviewer'))
  admin = await signIn(api.app, await createAccount(api.database, 'admin'))
})

afterAll(async () => {
  await api.close()
  await closeTestDatabase()
})

interface JobBody {
  id: string
  kind: string
  status: string
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
}

interface ExtractionBody {
  id: string
  parcelId: string
  sourceDocumentId: string | null
  pageId: string | null
  field: string
  recordedValue: string
  reviewStatus: string
  confidence: string | null
  isUnclear: boolean
  boundingBox: unknown
  provider: string | null
  providerModel: string | null
  origin: string
  extractedAt: string | null
}

const TERMINAL_JOB_STATUSES = new Set([
  'completed',
  'failed',
  'review_required',
  'cancelled',
])

const silentLogger = {
  info: (): void => undefined,
  warn: (): void => undefined,
  error: (): void => undefined,
}

async function loadJob(jobId: string): Promise<JobBody> {
  const response = await admin.get(`${API}/jobs/${jobId}`)
  expectStatus(response, 200)
  return response.json() as JobBody
}

/** Starts a worker and waits until the named job reaches a terminal state. */
async function runWorkerUntilSettled(
  jobId: string,
  provider: ExtractionProvider,
  options: { maxAttempts?: number; retryBackoffSeconds?: number } = {},
): Promise<JobBody> {
  const worker = new ExtractionWorker({
    database: api.database,
    provider,
    rulesVersion: VALIDATION_RULES_VERSION,
    workerId: `test-${randomUUID().slice(0, 8)}`,
    leaseSeconds: 30,
    maxAttempts: options.maxAttempts ?? 3,
    retryBackoffSeconds: options.retryBackoffSeconds ?? 0,
    pollIntervalMs: 20,
    // Readers are handed the file from the test's private storage directory.
    uploadDir: api.uploadDir,
    maxContentBytes: 5 * 1024 * 1024,
    log: silentLogger,
  })

  const running = worker.run()
  const deadline = Date.now() + 15_000

  try {
    for (;;) {
      const job = await loadJob(jobId)
      if (TERMINAL_JOB_STATUSES.has(job.status)) return job
      if (Date.now() > deadline) {
        throw new Error(`Job ${jobId} did not settle; last status was ${job.status}.`)
      }
      await new Promise((resolve) => setTimeout(resolve, 40))
    }
  } finally {
    worker.requestStop()
    await running
  }
}

/** Enqueues a document-extraction job for a document the client can see. */
async function enqueueExtraction(
  client: TestClient,
  parcelId: string,
  sourceDocumentId: string,
  extra: Record<string, unknown> = {},
): Promise<JobBody> {
  const response = await client.post(`${API}/jobs`, {
    kind: 'document_extraction',
    parcelId,
    sourceDocumentId,
    ...extra,
  })
  expectStatus(response, 202)
  return response.json() as JobBody
}

/**
 * Wraps a provider so only calls naming one document are counted.
 *
 * A worker drains the whole queue, not just the job a test is watching, so a raw
 * call count would depend on unrelated queued work.
 */
function scopedProvider(
  inner: ExtractionProvider,
  documentId: string,
): { provider: ExtractionProvider; calls: () => number } {
  let calls = 0

  const provider: ExtractionProvider = {
    name: inner.name,
    model: inner.model,
    requiresCredentials: inner.requiresCredentials,
    readsDocumentContent: inner.readsDocumentContent,
    supportedMediaTypes: inner.supportedMediaTypes,
    isConfigured: () => inner.isConfigured(),
    extract: async (request) => {
      if (request.sourceDocumentId === documentId) calls += 1
      return inner.extract(request)
    },
  }

  return { provider, calls: () => calls }
}

async function extractForParcel(parcelId: string): Promise<ExtractionBody[]> {
  const response = await applicant.get(`${API}/parcels/${parcelId}/extractions`)
  expectStatus(response, 200)
  return (response.json() as { items: ExtractionBody[] }).items
}

/* -------------------------------------------------------------------------- */
/* Enqueueing                                                                  */
/* -------------------------------------------------------------------------- */

describe('POST /jobs', () => {
  it('records a job and returns before any work has run', async () => {
    const parcel = await createParcel(applicant)
    const document = await createDocument(applicant)

    const job = await enqueueExtraction(applicant, parcel.id, document.id, {
      fields: ['area', 'share'],
    })

    expect(job.kind).toBe('document_extraction')
    expect(job.status).toBe('queued')
    expect(job.parcelId).toBe(parcel.id)
    expect(job.sourceDocumentId).toBe(document.id)
    expect(job.requestedBy).toBe(applicant.account.id)
    expect(job.attemptCount).toBe(0)
    expect(job.lockedBy).toBeNull()
    expect(job.startedAt).toBeNull()
    expect(job.finishedAt).toBeNull()
    expect(job.payload).toEqual({ fields: ['area', 'share'] })

    // The queue holds no result yet: nothing has read anything.
    expect(job.result).toBeNull()
  })

  it('treats a repeated idempotency key as the same job, not a second one', async () => {
    const parcel = await createParcel(applicant)
    const document = await createDocument(applicant)
    const idempotencyKey = uniqueIdempotencyKey()

    const first = await enqueueExtraction(applicant, parcel.id, document.id, {
      idempotencyKey,
    })

    const repeated = await applicant.post(`${API}/jobs`, {
      kind: 'document_extraction',
      parcelId: parcel.id,
      sourceDocumentId: document.id,
      idempotencyKey,
    })

    // 202 for a new job, 200 for the one that already existed.
    expectStatus(repeated, 200)
    const second = repeated.json() as JobBody

    expect(second.id).toBe(first.id)
    expect(second.idempotencyKey).toBe(idempotencyKey)
  })

  it('refuses a job naming a document the caller cannot see', async () => {
    const parcel = await createParcel(applicant)
    const theirs = await createDocument(otherApplicant)

    const response = await applicant.post(`${API}/jobs`, {
      kind: 'document_extraction',
      parcelId: parcel.id,
      sourceDocumentId: theirs.id,
    })

    expectError(response, 404, 'not_found')
  })

  it('refuses a job naming a parcel the caller cannot see', async () => {
    const theirs = await createParcel(otherApplicant)
    const document = await createDocument(applicant)

    const response = await applicant.post(`${API}/jobs`, {
      kind: 'document_extraction',
      parcelId: theirs.id,
      sourceDocumentId: document.id,
    })

    expectError(response, 404, 'not_found')
  })

  it('refuses an unknown field name and a missing document', async () => {
    const parcel = await createParcel(applicant)
    const document = await createDocument(applicant)

    const unknownField = await applicant.post(`${API}/jobs`, {
      kind: 'document_extraction',
      parcelId: parcel.id,
      sourceDocumentId: document.id,
      fields: ['mutation_number'],
    })
    expectError(unknownField, 422, 'validation_failed')

    const missingDocument = await applicant.post(`${API}/jobs`, {
      kind: 'document_extraction',
      parcelId: parcel.id,
    })
    expectError(missingDocument, 422, 'validation_failed')
  })

  it('requires authentication and a CSRF token', async () => {
    const parcel = await createParcel(applicant)
    const document = await createDocument(applicant)

    const anonymous = await api.app.inject({
      method: 'POST',
      url: `${API}/jobs`,
      headers: { 'content-type': 'application/json' },
      payload: {
        kind: 'document_extraction',
        parcelId: parcel.id,
        sourceDocumentId: document.id,
      },
    })
    expectError(anonymous, 401, 'unauthenticated')

    const noCsrf = await applicant.post(
      `${API}/jobs`,
      {
        kind: 'document_extraction',
        parcelId: parcel.id,
        sourceDocumentId: document.id,
      },
      { withCsrf: false },
    )
    expectError(noCsrf, 403, 'forbidden')
  })
})

/* -------------------------------------------------------------------------- */
/* Listing and cancelling                                                      */
/* -------------------------------------------------------------------------- */

describe('GET /jobs', () => {
  it('shows an applicant only their own jobs and filters by parcel', async () => {
    const parcel = await createParcel(applicant)
    const mine = await enqueueExtraction(
      applicant,
      parcel.id,
      (await createDocument(applicant)).id,
    )

    const theirs = await createParcel(otherApplicant)
    const notMine = await enqueueExtraction(
      otherApplicant,
      theirs.id,
      (await createDocument(otherApplicant)).id,
    )

    const response = await applicant.get(`${API}/jobs?limit=50&parcelId=${parcel.id}`)

    expectStatus(response, 200)
    const ids = (response.json() as { items: JobBody[] }).items.map((job) => job.id)
    expect(ids).toContain(mine.id)
    expect(ids).not.toContain(notMine.id)
  })

  it('shows a reviewer every job', async () => {
    const parcel = await createParcel(applicant)
    const job = await enqueueExtraction(
      applicant,
      parcel.id,
      (await createDocument(applicant)).id,
    )

    const response = await reviewer.get(`${API}/jobs/${job.id}`)

    expectStatus(response, 200)
    expect((response.json() as JobBody).id).toBe(job.id)
  })
})

describe('POST /jobs/:jobId/cancel', () => {
  it('cancels queued work before it is claimed', async () => {
    const parcel = await createParcel(applicant)
    const job = await enqueueExtraction(
      applicant,
      parcel.id,
      (await createDocument(applicant)).id,
    )

    const response = await applicant.post(`${API}/jobs/${job.id}/cancel`)

    expectStatus(response, 200)
    const cancelled = response.json() as JobBody
    expect(cancelled.status).toBe('cancelled')
    expect(cancelled.finishedAt).toEqual(expect.any(String))

    // Cancelling twice is a conflict, not a second cancellation.
    expectError(
      await applicant.post(`${API}/jobs/${job.id}/cancel`),
      409,
      'conflict',
    )
  })

  it('refuses to cancel somebody else’s job', async () => {
    const parcel = await createParcel(applicant)
    const job = await enqueueExtraction(
      applicant,
      parcel.id,
      (await createDocument(applicant)).id,
    )

    const response = await otherApplicant.post(`${API}/jobs/${job.id}/cancel`)

    expectError(response, 404, 'not_found')
  })

  it('lets a reviewer cancel an applicant’s queued job', async () => {
    const parcel = await createParcel(applicant)
    const job = await enqueueExtraction(
      applicant,
      parcel.id,
      (await createDocument(applicant)).id,
    )

    const response = await reviewer.post(`${API}/jobs/${job.id}/cancel`)

    expectStatus(response, 200)
    expect((response.json() as JobBody).status).toBe('cancelled')
  })
})

/* -------------------------------------------------------------------------- */
/* The worker                                                                  */
/* -------------------------------------------------------------------------- */

describe('the extraction worker', () => {
  it('records unreadable readings and reports that a person is needed', async () => {
    const parcel = await createParcel(applicant)
    const document = await createDocument(applicant)
    const job = await enqueueExtraction(applicant, parcel.id, document.id, {
      fields: ['area', 'share'],
    })

    // A document this provider has no fixture for: every field is unreadable,
    // which is an honest answer rather than a guessed one.
    const scoped = scopedProvider(new MockExtractionProvider(), document.id)
    const settled = await runWorkerUntilSettled(job.id, scoped.provider)

    expect(settled.status).toBe('review_required')
    expect(settled.attemptCount).toBe(1)
    expect(settled.lockedBy).toBeNull()
    expect(pairReadings(settled.result)).toEqual({ fieldCount: 2, unclearCount: 2 })
    expect(scoped.calls()).toBe(1)

    const readings = await extractForParcel(parcel.id)
    expect(readings).toHaveLength(2)
    for (const reading of readings) {
      expect(reading.provider).toBe('mock')
      expect(reading.providerModel).toBe('mock-v1')
      expect(reading.origin).toBe('provider')
      expect(reading.sourceDocumentId).toBe(document.id)
      expect(reading.isUnclear).toBe(true)
      expect(reading.reviewStatus).toBe('unclear')
      // Nothing was measured, so nothing is claimed.
      expect(reading.confidence).toBeNull()
      expect(reading.boundingBox).toBeNull()
    }
  })

  it('stores readable readings with their page, and completes', async () => {
    const parcel = await createParcel(applicant)
    const document = await createDocument(applicant)
    const page = await applicant.post(`${API}/documents/${document.id}/pages`, {
      pageNumber: 1,
      label: 'তফসিল',
    })
    expectStatus(page, 201)

    const job = await enqueueExtraction(applicant, parcel.id, document.id, {
      fields: ['khatian', 'area'],
    })

    // Fixtures are supplied at construction time; the provider has no way to
    // invent a reading for a document it was not given.
    const provider = new MockExtractionProvider({
      model: 'test-fixture-v1',
      fixtures: {
        [document.id]: {
          khatian: { value: '104', pageNumber: 1, pageReference: 'শিরোনাম, ঘর ১' },
          area: { value: '125.0000', pageNumber: 1, pageReference: 'তফসিল, ঘর ৩' },
        },
      },
    })

    const settled = await runWorkerUntilSettled(job.id, provider)

    expect(settled.status).toBe('completed')
    expect(pairReadings(settled.result)).toEqual({ fieldCount: 2, unclearCount: 0 })

    const readings = await extractForParcel(parcel.id)
    const byField = new Map(readings.map((reading) => [reading.field, reading]))
    expect(byField.get('khatian')?.recordedValue).toBe('104')
    expect(byField.get('area')?.recordedValue).toBe('125.0000')
    for (const reading of readings) {
      expect(reading.isUnclear).toBe(false)
      expect(reading.reviewStatus).toBe('pending')
      expect(reading.providerModel).toBe('test-fixture-v1')
      // The reported page number resolves to the stored page row.
      expect(reading.pageId).not.toBeNull()
      expect(reading.extractedAt).toEqual(expect.any(String))
    }
  })

  it('never overwrites a reading a person typed', async () => {
    const parcel = await createParcel(applicant)
    const document = await createDocument(applicant)

    const manual = await applicant.post(`${API}/parcels/${parcel.id}/extractions`, {
      field: 'area',
      recordedValue: '999.0000',
    })
    expectStatus(manual, 201)

    const job = await enqueueExtraction(applicant, parcel.id, document.id, {
      fields: ['area'],
    })
    const settled = await runWorkerUntilSettled(job.id, new MockExtractionProvider())
    expect(settled.status).toBe('review_required')

    const readings = await extractForParcel(parcel.id)
    // Two distinct readings of the same field: the person's and the provider's.
    expect(readings).toHaveLength(2)
    expect(readings.map((reading) => reading.recordedValue)).toEqual([
      '999.0000',
      '',
    ])
    expect(readings.map((reading) => reading.origin)).toEqual([
      'manual_entry',
      'provider',
    ])
  })

  it('retries a transient failure and then succeeds', async () => {
    const parcel = await createParcel(applicant)
    const document = await createDocument(applicant)
    const job = await enqueueExtraction(applicant, parcel.id, document.id, {
      fields: ['area'],
    })

    const scoped = scopedProvider(
      new MockExtractionProvider({
        failureMode: 'transient',
        failFirst: 1,
        fixtures: { [document.id]: { area: { value: '125.0000', pageNumber: null } } },
      }),
      document.id,
    )

    const settled = await runWorkerUntilSettled(job.id, scoped.provider, {
      maxAttempts: 3,
      retryBackoffSeconds: 0,
    })

    expect(settled.status).toBe('completed')
    // The first attempt failed and was retried, rather than the work being lost.
    expect(settled.attemptCount).toBe(2)
    expect(scoped.calls()).toBe(2)
    expect((await extractForParcel(parcel.id))[0]?.recordedValue).toBe('125.0000')
  })

  it('gives up after the attempt budget and keeps a sanitised reason', async () => {
    const parcel = await createParcel(applicant)
    const document = await createDocument(applicant)
    const job = await enqueueExtraction(applicant, parcel.id, document.id, {
      fields: ['area'],
    })

    const scoped = scopedProvider(
      new MockExtractionProvider({ failureMode: 'always' }),
      document.id,
    )
    const settled = await runWorkerUntilSettled(job.id, scoped.provider, {
      retryBackoffSeconds: 0,
    })

    expect(settled.status).toBe('failed')
    // The budget is finite, and the job stops exactly when it runs out: no
    // unbounded retrying of work that keeps failing.
    expect(settled.maxAttempts).toBeGreaterThan(1)
    expect(settled.attemptCount).toBe(settled.maxAttempts)
    expect(scoped.calls()).toBe(settled.maxAttempts)
    expect(settled.finishedAt).toEqual(expect.any(String))
    expect(settled.lastError).toEqual(expect.any(String))

    // A stored failure reason names the problem without carrying a stack trace
    // or an internal path into the database.
    expect(settled.lastError).not.toContain('    at ')
    expect(settled.lastError).not.toContain('node_modules')
    expect(settled.lastError).not.toContain('/Volumes/')

    // No reading was invented for the failed attempt.
    expect(await extractForParcel(parcel.id)).toEqual([])
  })

  it('recovers a job whose lease expired instead of losing it', async () => {
    const parcel = await createParcel(applicant)
    const document = await createDocument(applicant)
    const job = await enqueueExtraction(applicant, parcel.id, document.id, {
      fields: ['area'],
    })

    // Simulate a worker that claimed the job and then died mid-flight.
    await api.database.orm
      .update(processingJobs)
      .set({
        status: 'processing',
        attemptCount: 1,
        lockedBy: 'worker-that-died',
        leasedUntil: new Date(Date.now() - 60_000),
      })
      .where(eq(processingJobs.id, job.id))

    const settled = await runWorkerUntilSettled(job.id, new MockExtractionProvider())

    // Recovered and rerun rather than stranded in `processing` forever.
    expect(settled.status).toBe('review_required')
    expect(settled.attemptCount).toBe(2)
    expect(settled.lockedBy).toBeNull()
  })

  it('leaves cancelled work alone', async () => {
    const parcel = await createParcel(applicant)
    const cancelled = await enqueueExtraction(
      applicant,
      parcel.id,
      (await createDocument(applicant)).id,
    )
    expectStatus(await applicant.post(`${API}/jobs/${cancelled.id}/cancel`), 200)

    // A later job drives the worker; the cancelled one must not be picked up.
    const next = await enqueueExtraction(
      applicant,
      parcel.id,
      (await createDocument(applicant)).id,
      { fields: ['area'] },
    )
    const settled = await runWorkerUntilSettled(next.id, new MockExtractionProvider())
    expect(settled.status).toBe('review_required')

    expect((await loadJob(cancelled.id)).status).toBe('cancelled')
  })
})

describe('the other kinds of background work', () => {
  it('reconciles a parcel and attributes the findings it raises to the requester', async () => {
    const parcel = await createParcel(applicant)
    // Retire it first, so the check definitely has something to report: the
    // lifecycle rule fails on a retired record.
    expectStatus(
      await applicant.post(`${API}/parcels/${parcel.id}/retire`, {
        version: parcel.version,
        reason: 'Superseded by a corrected filing.',
      }),
      200,
    )

    const queued = await applicant.post(`${API}/jobs`, {
      kind: 'parcel_reconciliation',
      parcelId: parcel.id,
    })
    expectStatus(queued, 202)
    const job = queued.json() as JobBody

    const settled = await runWorkerUntilSettled(job.id, new MockExtractionProvider())

    expect(settled.status).toBe('review_required')
    expect(settled.requestedBy).toBe(applicant.account.id)
    const result = settled.result as {
      outcome: string
      counts: { pass: number; fail: number; needs_review: number }
      raisedFindings: number
    }
    // A summary of checks, not a verdict about ownership.
    expect(result.outcome).toBe('not_ready')
    expect(result.counts.pass).toBeGreaterThan(0)
    expect(result.raisedFindings).toBeGreaterThan(0)

    // The worker performed the queue transition, so that event names the
    // subsystem rather than a person.
    const jobEvents = await admin.get(
      `${API}/audit-events?action=job.review_required&entityId=${job.id}&limit=1`,
    )
    expectStatus(jobEvents, 200)
    const jobEvent = (jobEvents.json() as { items: { actorId: string | null; summary: string }[] })
      .items[0]
    expect(jobEvent?.actorId).toBeNull()
    expect(jobEvent?.summary).toBe('Job moved to review_required.')

    // The finding is the requester's, because they asked for the check to run.
    const findingEvents = await admin.get(
      `${API}/audit-events?action=finding.raised&actorId=${applicant.account.id}&limit=50`,
    )
    expectStatus(findingEvents, 200)
    const raised = (
      findingEvents.json() as {
        items: { actorId: string | null; changes: Record<string, unknown> | null }[]
      }
    ).items.find((event) => event.changes?.['ruleCode'] === 'RECORD_LIFECYCLE_ACTIVE')

    expect(raised?.actorId).toBe(applicant.account.id)
  })

  it('generates a readiness report as background work', async () => {
    const parcel = await createParcel(applicant)

    const queued = await applicant.post(`${API}/jobs`, {
      kind: 'readiness_report',
      parcelId: parcel.id,
    })
    expectStatus(queued, 202)
    const job = queued.json() as JobBody

    const settled = await runWorkerUntilSettled(job.id, new MockExtractionProvider())

    expect(['completed', 'review_required']).toContain(settled.status)
    const result = settled.result as { readinessReportId: string; outcome: string }
    expect(result.readinessReportId).toEqual(expect.any(String))

    // The report the job produced is the one a reader can now fetch, with the
    // rules version that was current when it ran.
    const fetched = await applicant.get(`${API}/readiness-reports/${result.readinessReportId}`)
    expectStatus(fetched, 200)
    const report = fetched.json() as {
      id: string
      outcome: string
      rulesVersion: string
      items: unknown[]
    }
    expect(report.id).toBe(result.readinessReportId)
    expect(report.outcome).toBe(result.outcome)
    expect(report.rulesVersion).toBe(VALIDATION_RULES_VERSION)
    expect(report.items.length).toBeGreaterThan(0)
  })

  it('refuses to run reconciliation work whose requester cannot be named', async () => {
    // A job created outside the API — an operator's script, say — has no
    // requesting account. Reconciliation attributes findings to a person, so
    // this is refused rather than silently attributed to nobody.
    const parcel = await createParcel(applicant)
    const rows = await api.database.orm
      .insert(processingJobs)
      .values({ kind: 'parcel_reconciliation', parcelId: parcel.id })
      .returning()
    const orphan = rows[0]
    expect(orphan).toBeDefined()

    const settled = await runWorkerUntilSettled(orphan!.id, new MockExtractionProvider())

    expect(settled.status).toBe('failed')
    expect(settled.lastError).toContain('cannot be attributed')
  })
})

/** Pulls the two counts out of a job result for a readable assertion. */
function pairReadings(result: Record<string, unknown> | null): {
  fieldCount: unknown
  unclearCount: unknown
} {
  return {
    fieldCount: result?.['fieldCount'],
    unclearCount: result?.['unclearCount'],
  }
}
