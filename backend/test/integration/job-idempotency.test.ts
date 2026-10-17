import { randomUUID } from 'node:crypto'

import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { processingJobs } from '../../src/db/schema/jobs.js'
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
 * Job idempotency keys, and who they belong to.
 *
 * An idempotency key is chosen by a client, so it cannot be trusted to be
 * globally unique. The property that matters is therefore not "one job per key"
 * but "one job per key **per requester**": two accounts that happen to pick the
 * same key must each get their own job, and neither may be handed the other's.
 *
 * The uniqueness is enforced by partial unique indexes, not by a
 * read-then-insert, so the guarantee holds under real concurrency — which is the
 * only condition in which it is worth anything.
 */

let api: TestApi
let applicant: TestClient
let otherApplicant: TestClient
let admin: TestClient

beforeAll(async () => {
  api = await createTestApi()

  applicant = await signIn(api.app, await createAccount(api.database, 'applicant'))
  otherApplicant = await signIn(api.app, await createAccount(api.database, 'applicant'))
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
  requestedBy: string | null
  idempotencyKey: string | null
  parcelId: string | null
  sourceDocumentId: string | null
  payload: Record<string, unknown> | null
}

/** Counts the rows that actually carry a key, straight from the database. */
async function rowsForKey(key: string): Promise<number> {
  const rows = await api.database.orm
    .select()
    .from(processingJobs)
    .where(eq(processingJobs.idempotencyKey, key))
  return rows.length
}

describe('POST /jobs idempotency keys', () => {
  it('returns the same job for a repeated key from the same caller', async () => {
    const parcel = await createParcel(applicant)
    const document = await createDocument(applicant)
    const idempotencyKey = uniqueIdempotencyKey('idem')

    const body = {
      kind: 'document_extraction',
      parcelId: parcel.id,
      sourceDocumentId: document.id,
      fields: ['area'],
      idempotencyKey,
    }

    const first = await applicant.post(`${API}/jobs`, body)
    expectStatus(first, 202)
    const created = first.json() as JobBody

    const repeated = await applicant.post(`${API}/jobs`, body)
    // 202 for new work, 200 for the work that already exists.
    expectStatus(repeated, 200)
    const existing = repeated.json() as JobBody

    expect(existing.id).toBe(created.id)
    expect(existing.requestedBy).toBe(applicant.account.id)
    // Exactly one row: the key really is the identity of the work.
    expect(await rowsForKey(idempotencyKey)).toBe(1)
  })

  it('resolves concurrent submissions of one key to a single job', async () => {
    const parcel = await createParcel(applicant)
    const idempotencyKey = uniqueIdempotencyKey('concurrent')

    const body = {
      kind: 'parcel_reconciliation',
      parcelId: parcel.id,
      idempotencyKey,
    }

    // Fired together, on purpose: a read-before-write check would let two of
    // these through and create two identical units of work.
    const responses = await Promise.all(
      Array.from({ length: 5 }, () => applicant.post(`${API}/jobs`, body)),
    )

    const ids = new Set<string>()
    for (const response of responses) {
      expect([200, 202]).toContain(response.statusCode)
      ids.add((response.json() as JobBody).id)
    }

    expect(ids.size).toBe(1)
    expect(await rowsForKey(idempotencyKey)).toBe(1)
  })

  it('scopes a key to its requester, so two accounts do not share a job', async () => {
    const mine = await createParcel(applicant)
    const theirs = await createParcel(otherApplicant)
    const idempotencyKey = uniqueIdempotencyKey('shared')

    const first = await applicant.post(`${API}/jobs`, {
      kind: 'parcel_reconciliation',
      parcelId: mine.id,
      idempotencyKey,
    })
    expectStatus(first, 202)
    const mineJob = first.json() as JobBody

    // The second account picks the same key. Because a single global unique
    // index would either refuse this or, worse, hand back the first account's
    // job, the index is scoped by requester instead.
    const second = await otherApplicant.post(`${API}/jobs`, {
      kind: 'parcel_reconciliation',
      parcelId: theirs.id,
      idempotencyKey,
    })
    expectStatus(second, 202)
    const theirJob = second.json() as JobBody

    expect(theirJob.id).not.toBe(mineJob.id)
    expect(theirJob.requestedBy).toBe(otherApplicant.account.id)
    expect(mineJob.requestedBy).toBe(applicant.account.id)
    expect(await rowsForKey(idempotencyKey)).toBe(2)
  })

  it('never shows either requester the other’s job', async () => {
    const mine = await createParcel(applicant)
    const theirs = await createParcel(otherApplicant)
    const idempotencyKey = uniqueIdempotencyKey('invisible')

    const first = await applicant.post(`${API}/jobs`, {
      kind: 'parcel_reconciliation',
      parcelId: mine.id,
      idempotencyKey,
    })
    expectStatus(first, 202)
    const mineJob = first.json() as JobBody

    const second = await otherApplicant.post(`${API}/jobs`, {
      kind: 'parcel_reconciliation',
      parcelId: theirs.id,
      idempotencyKey,
    })
    expectStatus(second, 202)
    const theirJob = second.json() as JobBody

    // Each caller reads back only the job the key means *to them*.
    const mineReadBack = await applicant.get(`${API}/jobs/${mineJob.id}`)
    expectStatus(mineReadBack, 200)
    expect((mineReadBack.json() as JobBody).id).toBe(mineJob.id)

    // And neither can see the other's, exactly as for any other job.
    expectError(await applicant.get(`${API}/jobs/${theirJob.id}`), 404, 'not_found')
    expectError(await otherApplicant.get(`${API}/jobs/${mineJob.id}`), 404, 'not_found')
  })

  it('rejects a key reused for a different payload, naming the existing job', async () => {
    const parcel = await createParcel(applicant)
    const document = await createDocument(applicant)
    const idempotencyKey = uniqueIdempotencyKey('reuse-payload')

    const first = await applicant.post(`${API}/jobs`, {
      kind: 'document_extraction',
      parcelId: parcel.id,
      sourceDocumentId: document.id,
      fields: ['area'],
      idempotencyKey,
    })
    expectStatus(first, 202)
    const existing = first.json() as JobBody

    const reused = await applicant.post(`${API}/jobs`, {
      kind: 'document_extraction',
      parcelId: parcel.id,
      sourceDocumentId: document.id,
      // Same key, different unit of work.
      fields: ['share'],
      idempotencyKey,
    })

    const error = expectError(reused, 409, 'idempotency_key_reused')
    expect(error.error.details).toEqual({ existingJobId: existing.id })
    expect(await rowsForKey(idempotencyKey)).toBe(1)
  })

  it('rejects a key reused against a different target', async () => {
    const firstParcel = await createParcel(applicant)
    const secondParcel = await createParcel(applicant)
    const idempotencyKey = uniqueIdempotencyKey('reuse-target')

    expectStatus(
      await applicant.post(`${API}/jobs`, {
        kind: 'parcel_reconciliation',
        parcelId: firstParcel.id,
        idempotencyKey,
      }),
      202,
    )

    const reused = await applicant.post(`${API}/jobs`, {
      kind: 'parcel_reconciliation',
      parcelId: secondParcel.id,
      idempotencyKey,
    })

    expectError(reused, 409, 'idempotency_key_reused')
    expect(await rowsForKey(idempotencyKey)).toBe(1)
  })

  it('rejects a key reused for a different operation', async () => {
    const parcel = await createParcel(applicant)
    const idempotencyKey = uniqueIdempotencyKey('reuse-kind')

    expectStatus(
      await applicant.post(`${API}/jobs`, {
        kind: 'parcel_reconciliation',
        parcelId: parcel.id,
        idempotencyKey,
      }),
      202,
    )

    // The key stood for a reconciliation; it cannot now stand for a report.
    const reused = await applicant.post(`${API}/jobs`, {
      kind: 'readiness_report',
      parcelId: parcel.id,
      idempotencyKey,
    })

    expectError(reused, 409, 'idempotency_key_reused')
    expect(await rowsForKey(idempotencyKey)).toBe(1)
  })

  it('lets a key be reused once the meaning is the same, whatever the field order', async () => {
    const parcel = await createParcel(applicant)
    const document = await createDocument(applicant)
    const idempotencyKey = uniqueIdempotencyKey('order')

    expectStatus(
      await applicant.post(`${API}/jobs`, {
        kind: 'document_extraction',
        parcelId: parcel.id,
        sourceDocumentId: document.id,
        fields: ['area', 'khatian'],
        idempotencyKey,
      }),
      202,
    )

    // The same request again: the fingerprint compares meaning, not the order in
    // which a JSON object happened to be serialised.
    const repeated = await applicant.post(`${API}/jobs`, {
      idempotencyKey,
      fields: ['area', 'khatian'],
      sourceDocumentId: document.id,
      parcelId: parcel.id,
      kind: 'document_extraction',
    })

    expectStatus(repeated, 200)
    expect(await rowsForKey(idempotencyKey)).toBe(1)
  })

  it('does not constrain jobs that carry no key', async () => {
    const parcel = await createParcel(applicant)

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await applicant.post(`${API}/jobs`, {
        kind: 'parcel_reconciliation',
        parcelId: parcel.id,
      })
      expectStatus(response, 202)
      expect((response.json() as JobBody).idempotencyKey).toBeNull()
    }
  })

  it('keeps the keys of different callers from colliding in the audit trail', async () => {
    const parityKey = `audit-parity-${randomUUID()}`
    const mine = await createParcel(applicant)
    const theirs = await createParcel(otherApplicant)

    expectStatus(
      await applicant.post(`${API}/jobs`, {
        kind: 'parcel_reconciliation',
        parcelId: mine.id,
        idempotencyKey: parityKey,
      }),
      202,
    )
    expectStatus(
      await otherApplicant.post(`${API}/jobs`, {
        kind: 'parcel_reconciliation',
        parcelId: theirs.id,
        idempotencyKey: parityKey,
      }),
      202,
    )

    const rows = await api.database.orm
      .select()
      .from(processingJobs)
      .where(eq(processingJobs.idempotencyKey, parityKey))

    // Two rows, each attributed to the account that asked for it.
    expect(rows).toHaveLength(2)
    expect(new Set(rows.map((row) => row.requestedBy))).toEqual(
      new Set([applicant.account.id, otherApplicant.account.id]),
    )
  })
})

describe('job visibility', () => {
  it('hides another account’s job behind a 404, not a 403', async () => {
    const parcel = await createParcel(applicant)
    const queued = await applicant.post(`${API}/jobs`, {
      kind: 'parcel_reconciliation',
      parcelId: parcel.id,
    })
    expectStatus(queued, 202)
    const job = queued.json() as JobBody

    // A 403 would confirm the job exists; a 404 says only that this caller may
    // not act on that identifier — the same answer as an identifier that names
    // nothing at all.
    expectError(await otherApplicant.get(`${API}/jobs/${job.id}`), 404, 'not_found')
    expectError(await admin.get(`${API}/jobs/${randomUUID()}`), 404, 'not_found')
  })
})
