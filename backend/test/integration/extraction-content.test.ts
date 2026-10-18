import { createHash, randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'

import { and, eq, isNotNull } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { VALIDATION_RULES_VERSION } from '../../src/config/constants.js'
import { sourceDocuments } from '../../src/db/schema/documents.js'
import { extractions } from '../../src/db/schema/extractions.js'
import { auditEvents } from '../../src/db/schema/audit.js'
import { processingJobs } from '../../src/db/schema/jobs.js'
import type {
  ExtractionProvider,
  ExtractionRequest,
  ExtractionResult,
} from '../../src/extraction/provider.js'
import { ExtractionWorker } from '../../src/worker/runner.js'
import {
  API,
  createAccount,
  createDocument,
  createParcel,
  createTestApi,
  expectStatus,
  pdfFixture,
  pngFixture,
  signIn,
  uploadDocument,
  type TestApi,
  type TestClient,
} from '../helpers/api.js'
import { closeTestDatabase } from '../helpers/database.js'

/**
 * The document a reader is actually given.
 *
 * A provider that claims to read documents must be handed the stored bytes — not
 * a title, not a reference, not a page count. These tests drive a real worker
 * against a provider that records the request it received, and assert on what
 * arrived:
 *
 * - the media type, size, and checksum are those of the stored file;
 * - a record with no file, an unsupported media type, a missing file, a
 *   tampered file, or a file over the size ceiling fails the job and stores
 *   nothing — never a value invented from metadata;
 * - the bytes never travel through a job payload or an audit row.
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

/** A reader that records every request and answers from the content it got. */
class RecordingReader implements ExtractionProvider {
  readonly name = 'recording-reader'
  readonly model = 'recording-reader-v1'
  readonly requiresCredentials = false
  readonly readsDocumentContent = true
  readonly requests: ExtractionRequest[] = []

  constructor(
    readonly supportedMediaTypes: readonly string[],
    /** When set, the reader refuses to produce an answer, like an outage. */
    private readonly failure: Error | null = null,
  ) {}

  isConfigured(): boolean {
    return true
  }

  async extract(request: ExtractionRequest): Promise<ExtractionResult> {
    this.requests.push(request)
    if (this.failure !== null) throw this.failure

    return {
      provider: this.name,
      model: this.model,
      extractedAt: new Date(),
      fields: request.fields.map((field) => ({
        field,
        value: field === 'area' ? '125.0000' : '104',
        confidence: 0.9,
        isUnclear: false,
        pageNumber: null,
        pageReference: null,
        boundingBox: null,
      })),
      warnings: [],
    }
  }
}

async function loadDocument(documentId: string) {
  const rows = await api.database.orm
    .select()
    .from(sourceDocuments)
    .where(eq(sourceDocuments.id, documentId))
    .limit(1)
  const document = rows[0]
  if (document === undefined) throw new Error(`Document ${documentId} disappeared.`)
  return document
}

async function readingsFor(
  parcelId: string,
): Promise<(typeof extractions.$inferSelect)[]> {
  return api.database.orm
    .select()
    .from(extractions)
    .where(and(eq(extractions.parcelId, parcelId), isNotNull(extractions.provider)))
}

/** Runs a worker until the named job settles. */
async function runUntilSettled(
  jobId: string,
  provider: ExtractionProvider,
  options: { maxAttempts?: number; maxContentBytes?: number } = {},
): Promise<(typeof processingJobs.$inferSelect)> {
  const worker = new ExtractionWorker({
    database: api.database,
    provider,
    rulesVersion: VALIDATION_RULES_VERSION,
    workerId: `content-${randomUUID().slice(0, 8)}`,
    leaseSeconds: 30,
    maxAttempts: options.maxAttempts ?? 3,
    retryBackoffSeconds: 0,
    pollIntervalMs: 10,
    uploadDir: api.uploadDir,
    maxContentBytes: options.maxContentBytes ?? 5 * 1024 * 1024,
    log: silentLogger,
  })

  const running = worker.run()
  const deadline = Date.now() + 15_000
  const terminal = new Set(['completed', 'failed', 'review_required', 'cancelled'])

  try {
    for (;;) {
      const rows = await api.database.orm
        .select()
        .from(processingJobs)
        .where(eq(processingJobs.id, jobId))
        .limit(1)
      const job = rows[0]
      if (job === undefined) throw new Error(`Job ${jobId} disappeared.`)
      if (terminal.has(job.status)) return job
      if (Date.now() > deadline) {
        throw new Error(`Job never settled; status was ${job.status}.`)
      }
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  } finally {
    worker.requestStop()
    await running
  }
}

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
/* A reader receives the document                                              */
/* -------------------------------------------------------------------------- */

describe('a reader that reads documents', () => {
  it('is handed the stored bytes, with the recorded media type and checksum', async () => {
    const parcel = await createParcel(applicant)
    const contents = pdfFixture('content-path')
    const upload = await uploadDocument(applicant, contents, {
      title: 'Uploaded khatian scan',
      filename: 'khatian-scan.pdf',
    })
    expectStatus(upload, 201)
    const documentId = (upload.json() as { id: string }).id

    const jobId = await enqueueExtraction(parcel.id, documentId, ['khatian', 'area'])

    const reader = new RecordingReader(['application/pdf'])
    const settled = await runUntilSettled(jobId, reader)

    expect(settled.status).toBe('completed')
    expect(reader.requests).toHaveLength(1)

    const request = reader.requests[0]!
    expect(request.content).not.toBeNull()
    // The bytes are the file that was uploaded, byte for byte.
    expect(Buffer.from(request.content!.bytes).equals(contents)).toBe(true)
    expect(request.content!.byteSize).toBe(contents.byteLength)
    expect(request.content!.mediaType).toBe('application/pdf')
    expect(request.content!.sha256).toBe(
      createHash('sha256').update(contents).digest('hex'),
    )

    // The result says plainly that these readings came from a real read.
    const result = settled.result as {
      readsDocumentContent: boolean
      hadStoredContent: boolean
    }
    expect(result.readsDocumentContent).toBe(true)
    expect(result.hadStoredContent).toBe(true)

    // And the reading the reader produced is what was persisted.
    const readings = await readingsFor(parcel.id)
    expect(readings).toHaveLength(2)
    expect(readings.every((reading) => reading.provider === 'recording-reader')).toBe(true)
  })

  it('is handed a PNG with its sniffed media type, not the client’s claim', async () => {
    const parcel = await createParcel(applicant)
    const contents = pngFixture()
    const upload = await uploadDocument(applicant, contents, {
      title: 'A photographed page',
      filename: 'page.png',
      // A plausible lie: the declared type is ignored in favour of the signature.
      declaredType: 'application/pdf',
    })
    expectStatus(upload, 201)
    const documentId = (upload.json() as { id: string }).id

    const jobId = await enqueueExtraction(parcel.id, documentId, ['area'])
    const reader = new RecordingReader(['image/png', 'image/jpeg'])
    const settled = await runUntilSettled(jobId, reader)

    expect(settled.status).toBe('completed')
    expect(reader.requests[0]?.content?.mediaType).toBe('image/png')
    expect(Buffer.from(reader.requests[0]!.content!.bytes).equals(contents)).toBe(true)
  })

  it('never puts the document bytes in the job payload or an audit row', async () => {
    const parcel = await createParcel(applicant)
    const contents = pdfFixture('no-leak')
    const upload = await uploadDocument(applicant, contents, { filename: 'leak-check.pdf' })
    expectStatus(upload, 201)
    const documentId = (upload.json() as { id: string }).id

    const jobId = await enqueueExtraction(parcel.id, documentId, ['area'])
    const settled = await runUntilSettled(jobId, new RecordingReader(['application/pdf']))
    expect(settled.status).toBe('completed')

    // The payload is the request metadata and nothing else.
    expect(JSON.stringify(settled.payload)).not.toContain('content')

    // No audit row for this job carries the file.
    const base64 = contents.toString('base64')
    const rows = await api.database.orm
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.entityId, jobId))
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      expect(JSON.stringify(row.changes)).not.toContain(base64)
    }
  })
})

/* -------------------------------------------------------------------------- */
/* A reader is refused what it cannot read                                     */
/* -------------------------------------------------------------------------- */

describe('a request that cannot be read is never answered from metadata', () => {
  it('fails a metadata-only record and stores no reading', async () => {
    const parcel = await createParcel(applicant)
    // Created through the API: it describes a document the platform holds no
    // copy of.
    const document = await createDocument(applicant)
    const jobId = await enqueueExtraction(parcel.id, document.id, ['area'])

    const reader = new RecordingReader(['application/pdf'])
    const settled = await runUntilSettled(jobId, reader)

    expect(settled.status).toBe('failed')
    expect(settled.lastError).toContain('no stored file')
    // The reader was never even called: there was nothing to read.
    expect(reader.requests).toHaveLength(0)
    expect(await readingsFor(parcel.id)).toEqual([])
    expect(settled.result).toBeNull()
  })

  it('fails an unsupported media type instead of sending it anyway', async () => {
    const parcel = await createParcel(applicant)
    const upload = await uploadDocument(applicant, pngFixture(), { filename: 'page.png' })
    expectStatus(upload, 201)
    const documentId = (upload.json() as { id: string }).id

    const jobId = await enqueueExtraction(parcel.id, documentId, ['area'])
    // A reader that only accepts PDFs.
    const reader = new RecordingReader(['application/pdf'])
    const settled = await runUntilSettled(jobId, reader)

    expect(settled.status).toBe('failed')
    expect(settled.lastError).toContain('image/png')
    expect(reader.requests).toHaveLength(0)
    expect(await readingsFor(parcel.id)).toEqual([])
  })

  it('fails when the stored file is missing rather than answering from metadata', async () => {
    const parcel = await createParcel(applicant)
    const upload = await uploadDocument(applicant, pdfFixture('vanishing'), {
      filename: 'vanishing.pdf',
    })
    expectStatus(upload, 201)
    const documentId = (upload.json() as { id: string }).id

    // The file disappears behind the record, as it would if storage were lost.
    const document = await loadDocument(documentId)
    expect(document.storageKey).not.toBeNull()
    await rm(join(api.uploadDir, document.storageKey!), { force: true })

    const jobId = await enqueueExtraction(parcel.id, documentId, ['area'])
    const reader = new RecordingReader(['application/pdf'])
    const settled = await runUntilSettled(jobId, reader)

    expect(settled.status).toBe('failed')
    expect(reader.requests).toHaveLength(0)
    expect(await readingsFor(parcel.id)).toEqual([])
    expect(settled.result).toBeNull()
  })

  it('fails when the file does not match its recorded checksum', async () => {
    const parcel = await createParcel(applicant)
    const upload = await uploadDocument(applicant, pdfFixture('tamper'), {
      filename: 'tamper.pdf',
    })
    expectStatus(upload, 201)
    const documentId = (upload.json() as { id: string }).id

    // A record whose checksum no longer describes the file on disk: the reader
    // must not be handed bytes the platform cannot vouch for.
    await api.database.orm
      .update(sourceDocuments)
      .set({ checksumSha256: 'f'.repeat(64) })
      .where(eq(sourceDocuments.id, documentId))

    const jobId = await enqueueExtraction(parcel.id, documentId, ['area'])
    const reader = new RecordingReader(['application/pdf'])
    const settled = await runUntilSettled(jobId, reader)

    expect(settled.status).toBe('failed')
    expect(reader.requests).toHaveLength(0)
    expect(await readingsFor(parcel.id)).toEqual([])
  })

  it('fails a file above the size ceiling instead of sending a partial read', async () => {
    const parcel = await createParcel(applicant)
    const upload = await uploadDocument(applicant, pdfFixture('big'), { filename: 'big.pdf' })
    expectStatus(upload, 201)
    const documentId = (upload.json() as { id: string }).id

    const jobId = await enqueueExtraction(parcel.id, documentId, ['area'])
    const reader = new RecordingReader(['application/pdf'])
    // A ceiling smaller than any real document.
    const settled = await runUntilSettled(jobId, reader, { maxContentBytes: 8 })

    expect(settled.status).toBe('failed')
    expect(reader.requests).toHaveLength(0)
    expect(await readingsFor(parcel.id)).toEqual([])
  })

  it('stores nothing when the reader itself fails', async () => {
    const parcel = await createParcel(applicant)
    const upload = await uploadDocument(applicant, pdfFixture('outage'), {
      filename: 'outage.pdf',
    })
    expectStatus(upload, 201)
    const documentId = (upload.json() as { id: string }).id

    const jobId = await enqueueExtraction(parcel.id, documentId, ['area'])
    const reader = new RecordingReader(
      ['application/pdf'],
      new Error('the model timed out'),
    )
    const settled = await runUntilSettled(jobId, reader, { maxAttempts: 2 })

    expect(settled.status).toBe('failed')
    // A failure is never converted into an empty success.
    expect(settled.result).toBeNull()
    expect(await readingsFor(parcel.id)).toEqual([])
  })
})
