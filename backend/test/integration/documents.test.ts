import { createHash } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  API,
  createAccount,
  createDocument,
  createTestApi,
  expectError,
  expectStatus,
  multipartBody,
  pdfFixture,
  pngFixture,
  signIn,
  unknownUuid,
  uploadDocument,
  type DocumentBody,
  type TestApi,
  type TestClient,
} from '../helpers/api.js'
import { closeTestDatabase } from '../helpers/database.js'

/**
 * Source documents: provenance, storage, and access.
 *
 * Two properties carry the weight here:
 *
 * 1. A document that belongs to somebody else is indistinguishable from one
 *    that does not exist, to an applicant.
 * 2. The declared content type is never believed, and the internal storage key
 *    never leaves the process.
 */

/** Small enough that an over-limit upload costs nothing to send. */
const UPLOAD_LIMIT_BYTES = 4096

let api: TestApi
let applicant: TestClient
let otherApplicant: TestClient
let reviewer: TestClient
let admin: TestClient

beforeAll(async () => {
  api = await createTestApi({ UPLOAD_MAX_BYTES: String(UPLOAD_LIMIT_BYTES) })

  applicant = await signIn(api.app, await createAccount(api.database, 'applicant'))
  otherApplicant = await signIn(api.app, await createAccount(api.database, 'applicant'))
  reviewer = await signIn(api.app, await createAccount(api.database, 'reviewer'))
  admin = await signIn(api.app, await createAccount(api.database, 'admin'))
})

afterAll(async () => {
  await api.close()
  await closeTestDatabase()
})

interface PageBody {
  id: string
  pageNumber: number
  label: string | null
  width: number | null
  height: number | null
  region: { x: number; y: number; width: number; height: number } | null
}

/** Lists a directory, returning an empty array when it does not exist yet. */
async function listFiles(directory: string): Promise<string[]> {
  try {
    return await readdir(directory)
  } catch {
    return []
  }
}

describe('POST /documents', () => {
  it('registers a manual-entry document with no stored file', async () => {
    const response = await applicant.post(`${API}/documents`, {
      title: 'Manual khatian entry',
      kind: 'manual_entry',
      reference: 'Entry taken from the registrar’s copy.',
      pageCount: 2,
    })

    expectStatus(response, 201)
    const document = response.json() as DocumentBody

    expect(document.ownerId).toBe(applicant.account.id)
    expect(document.origin).toBe('user_created')
    expect(document.title).toBe('Manual khatian entry')
    expect(document.kind).toBe('manual_entry')
    expect(document.status).toBe('submitted')
    expect(document.version).toBe(1)

    // "No file" is stated, never implied by an absent field.
    expect(document.hasStoredFile).toBe(false)
    expect(document.checksumSha256).toBeNull()
    expect(document.contentType).toBeNull()
    expect(document.byteSize).toBeNull()
    expect(document.originalFilename).toBeNull()

    // The storage key is not part of the contract at all.
    expect(response.body).not.toContain('storageKey')
  })

  it('stores the page references supplied with the document', async () => {
    const document = await createDocument(applicant, { pageCount: 2 })
    const response = await applicant.post(`${API}/documents/${document.id}/pages`, {
      pageNumber: 2,
      label: 'তফসিল',
      width: 1200,
      height: 1800,
      region: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
    })

    expectStatus(response, 201)
    const page = response.json() as PageBody
    expect(page.pageNumber).toBe(2)
    expect(page.label).toBe('তফসিল')
    expect(page.region).toEqual({ x: 0.1, y: 0.2, width: 0.3, height: 0.4 })

    const listed = await applicant.get(`${API}/documents/${document.id}/pages`)
    expectStatus(listed, 200)
    expect((listed.json() as { items: PageBody[] }).items.map((item) => item.pageNumber)).toEqual([
      2,
    ])
  })

  it('refuses two pages with the same number', async () => {
    const document = await createDocument(applicant)

    const first = await applicant.post(`${API}/documents`, {
      title: 'Duplicate page source',
      kind: 'manual_entry',
      pages: [{ pageNumber: 1 }, { pageNumber: 1 }],
    })

    expectError(first, 409, 'conflict')

    const existing = await applicant.post(`${API}/documents/${document.id}/pages`, {
      pageNumber: 1,
    })
    expectStatus(existing, 201)

    const repeated = await applicant.post(`${API}/documents/${document.id}/pages`, {
      pageNumber: 1,
    })
    const body = expectError(repeated, 409, 'conflict')
    expect(body.error.message).not.toContain('document_pages_document_page_unique')
  })

  it('ignores an ownerId sent by an applicant but honours an administrator', async () => {
    const mine = await createDocument(applicant, { ownerId: otherApplicant.account.id })
    expect(mine.ownerId).toBe(applicant.account.id)

    const theirs = await createDocument(admin, { ownerId: applicant.account.id })
    expect(theirs.ownerId).toBe(applicant.account.id)

    const response = await admin.post(`${API}/documents`, {
      title: 'Filed for a stranger',
      kind: 'manual_entry',
      ownerId: unknownUuid(),
    })
    expectError(response, 404, 'not_found')
  })

  it('requires authentication and a CSRF token', async () => {
    const anonymous = await api.app.inject({
      method: 'POST',
      url: `${API}/documents`,
      headers: { 'content-type': 'application/json' },
      payload: { title: 'Anonymous', kind: 'manual_entry' },
    })
    expectError(anonymous, 401, 'unauthenticated')

    const noCsrf = await applicant.post(
      `${API}/documents`,
      { title: 'No CSRF', kind: 'manual_entry' },
      { withCsrf: false },
    )
    expectError(noCsrf, 403, 'forbidden')
  })
})

describe('POST /documents/upload', () => {
  it('stores a PDF, records its checksum, and never returns the storage key', async () => {
    const contents = pdfFixture('upload-pdf')

    const response = await uploadDocument(applicant, contents, {
      title: 'Uploaded khatian scan',
      filename: 'khatian-scan.pdf',
    })

    expectStatus(response, 201)
    const document = response.json() as DocumentBody

    expect(document.hasStoredFile).toBe(true)
    // Sniffed from the bytes, not taken from the declared type.
    expect(document.contentType).toBe('application/pdf')
    expect(document.byteSize).toBe(contents.length)
    expect(document.checksumSha256).toBe(
      createHash('sha256').update(contents).digest('hex'),
    )
    expect(document.originalFilename).toBe('khatian-scan.pdf')
    expect(document.origin).toBe('user_created')
    expect(document.ownerId).toBe(applicant.account.id)

    expect(response.body).not.toContain('storageKey')
    expect(response.body).not.toContain(api.uploadDir)
  })

  it('accepts a PNG and a JPEG, still by signature', async () => {
    const png = await uploadDocument(applicant, pngFixture(), {
      title: 'Uploaded PNG',
      filename: 'scan.png',
    })
    expectStatus(png, 201)
    expect((png.json() as DocumentBody).contentType).toBe('image/png')

    // The JPEG signature is the first three bytes; the rest is filler that no
    // parser is asked to understand, because nothing decodes the image.
    const jpegBytes = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
      Buffer.alloc(64, 0x00),
    ])
    const jpeg = await uploadDocument(applicant, jpegBytes, {
      title: 'Uploaded JPEG',
      filename: 'scan.jpg',
      declaredType: 'image/png',
    })
    expectStatus(jpeg, 201)
    expect((jpeg.json() as DocumentBody).contentType).toBe('image/jpeg')
  })

  it('refuses a file whose bytes do not match any accepted type', async () => {
    const response = await uploadDocument(
      applicant,
      Buffer.from('This is plain text pretending to be a PDF.\n'),
      { title: 'Not really a PDF', filename: 'fake.pdf', declaredType: 'application/pdf' },
    )

    expectError(response, 415, 'unsupported_media_type')
  })

  it('refuses an upload over the size limit, leaving no record and no file', async () => {
    const before = await listFiles(api.uploadDir)
    const oversized = Buffer.concat([
      Buffer.from('%PDF-1.7\n'),
      Buffer.alloc(UPLOAD_LIMIT_BYTES + 1024, 0x41),
    ])

    const response = await uploadDocument(applicant, oversized, {
      title: 'Oversized upload marker',
      filename: 'too-big.pdf',
    })

    expectError(response, 413, 'payload_too_large')

    // Nothing was kept: a rejected upload must not leave a document behind, and
    // must not leave bytes on disk.
    const listed = await applicant.get(
      `${API}/documents?limit=50&title=${encodeURIComponent('Oversized upload marker')}`,
    )
    expectStatus(listed, 200)
    expect((listed.json() as { items: DocumentBody[] }).items).toEqual([])

    expect(await listFiles(api.uploadDir)).toEqual(before)
  })

  it('refuses a multipart body that carries no file part', async () => {
    const boundary = '----bhoomitrace-empty-part'
    const response = await applicant.post(
      `${API}/documents/upload?title=${encodeURIComponent('No file at all')}&kind=manual_entry`,
      undefined,
      {
        rawBody: Buffer.from(`--${boundary}--\r\n`),
        contentType: `multipart/form-data; boundary=${boundary}`,
      },
    )

    expectError(response, 422, 'validation_failed')
  })

  it('requires a title and a kind in the query string', async () => {
    const { body, contentType } = multipartBody('x.pdf', pdfFixture())
    const response = await applicant.post(
      `${API}/documents/upload?kind=manual_entry`,
      undefined,
      { rawBody: body, contentType },
    )

    // The query schema is the only metadata channel, so its absence is refused
    // before any bytes are stored.
    expectError(response, 422, 'validation_failed')
  })
})

describe('GET /documents', () => {
  it('shows an applicant only their own documents', async () => {
    const mine = await createDocument(applicant, { title: 'Mine alone' })
    const theirs = await createDocument(otherApplicant, { title: 'Theirs alone' })

    const response = await applicant.get(`${API}/documents?limit=100`)

    expectStatus(response, 200)
    const ids = (response.json() as { items: DocumentBody[] }).items.map((item) => item.id)
    expect(ids).toContain(mine.id)
    expect(ids).not.toContain(theirs.id)
  })

  it('shows a reviewer every document', async () => {
    const mine = await createDocument(applicant, { title: 'Visible to review' })

    const response = await reviewer.get(`${API}/documents/${mine.id}`)

    expectStatus(response, 200)
    expect((response.json() as DocumentBody).id).toBe(mine.id)
  })

  it('filters by kind and reference', async () => {
    const document = await createDocument(applicant, {
      title: 'Filterable document',
      kind: 'external_reference',
      reference: `REF-${Date.now().toString(36)}`,
    })

    const response = await applicant.get(
      `${API}/documents?limit=50&kind=external_reference&reference=${encodeURIComponent(
        document.reference ?? '',
      )}`,
    )

    expectStatus(response, 200)
    expect((response.json() as { items: DocumentBody[] }).items.map((item) => item.id)).toEqual([
      document.id,
    ])
  })
})

describe('GET /documents/:documentId', () => {
  it('reports somebody else’s document as not found', async () => {
    const theirs = await createDocument(otherApplicant)

    const response = await applicant.get(`${API}/documents/${theirs.id}`)
    const missing = await applicant.get(`${API}/documents/${unknownUuid()}`)

    expectError(response, 404, 'not_found')
    expectError(missing, 404, 'not_found')
  })

  it('gives an unauthenticated caller nothing', async () => {
    const document = await createDocument(applicant)

    const response = await api.app.inject({
      method: 'GET',
      url: `${API}/documents/${document.id}`,
    })

    expectError(response, 401, 'unauthenticated')
  })
})

describe('PATCH /documents/:documentId', () => {
  it('updates metadata and advances the version', async () => {
    const document = await createDocument(applicant, { title: 'Before the change' })

    const response = await applicant.patch(`${API}/documents/${document.id}`, {
      version: document.version,
      title: 'After the change',
      status: 'in_review',
    })

    expectStatus(response, 200)
    const updated = response.json() as DocumentBody
    expect(updated.title).toBe('After the change')
    expect(updated.status).toBe('in_review')
    expect(updated.version).toBeGreaterThan(document.version)
  })

  it('refuses a stale version rather than overwriting', async () => {
    const document = await createDocument(applicant)

    expectStatus(
      await applicant.patch(`${API}/documents/${document.id}`, {
        version: document.version,
        title: 'First writer',
      }),
      200,
    )

    const stale = await applicant.patch(`${API}/documents/${document.id}`, {
      version: document.version,
      title: 'Second writer',
    })

    expectError(stale, 409, 'concurrent_modification')
  })

  it('reports another applicant’s document as not found', async () => {
    const theirs = await createDocument(otherApplicant)

    const response = await applicant.patch(`${API}/documents/${theirs.id}`, {
      version: theirs.version,
      title: 'Not mine',
    })

    expectError(response, 404, 'not_found')
  })

  it('refuses a reviewer who can read the document but does not own it', async () => {
    const document = await createDocument(applicant)

    const response = await reviewer.patch(`${API}/documents/${document.id}`, {
      version: document.version,
      title: 'Rewritten by review',
    })

    // A reviewer corrects by recording a decision, not by editing the evidence.
    expectError(response, 403, 'forbidden')
  })

  it('lets an administrator change a document they do not own', async () => {
    const document = await createDocument(applicant)

    const response = await admin.patch(`${API}/documents/${document.id}`, {
      version: document.version,
      status: 'requested',
    })

    expectStatus(response, 200)
    expect((response.json() as DocumentBody).status).toBe('requested')
  })
})

describe('POST /documents/:documentId/pages', () => {
  it('refuses a reviewer adding a page to somebody else’s document', async () => {
    const document = await createDocument(applicant)

    const response = await reviewer.post(`${API}/documents/${document.id}/pages`, {
      pageNumber: 3,
    })

    expectError(response, 403, 'forbidden')
  })

  it('reports another applicant’s document as not found', async () => {
    const theirs = await createDocument(otherApplicant)

    const response = await applicant.post(`${API}/documents/${theirs.id}/pages`, {
      pageNumber: 3,
    })

    expectError(response, 404, 'not_found')
  })
})

describe('GET /documents/:documentId/file', () => {
  it('streams back exactly the stored bytes', async () => {
    const contents = pdfFixture('download-round-trip')
    const upload = await uploadDocument(applicant, contents, {
      title: 'Downloadable evidence',
      filename: 'evidence.pdf',
    })
    expectStatus(upload, 201)
    const document = upload.json() as DocumentBody

    const response = await applicant.get(`${API}/documents/${document.id}/file`)

    expectStatus(response, 200)
    expect(response.headers['content-type']).toBe('application/pdf')
    expect(response.headers['content-disposition']).toBe('attachment')
    expect(response.rawPayload.equals(contents)).toBe(true)
  })

  it('reports a document with no stored file as not found', async () => {
    const document = await createDocument(applicant)

    const response = await applicant.get(`${API}/documents/${document.id}/file`)

    expectError(response, 404, 'not_found')
  })

  it('reports somebody else’s file as not found', async () => {
    const upload = await uploadDocument(otherApplicant, pdfFixture('theirs'), {
      title: 'Not mine to download',
    })
    expectStatus(upload, 201)
    const document = upload.json() as DocumentBody

    const response = await applicant.get(`${API}/documents/${document.id}/file`)

    expectError(response, 404, 'not_found')
  })

  it('requires authentication', async () => {
    const upload = await uploadDocument(applicant, pdfFixture('private'), {
      title: 'Private evidence',
    })
    expectStatus(upload, 201)
    const document = upload.json() as DocumentBody

    const response = await api.app.inject({
      method: 'GET',
      url: `${API}/documents/${document.id}/file`,
    })

    expectError(response, 401, 'unauthenticated')
  })
})

describe('no deletion path', () => {
  it('has no delete endpoint for a document', async () => {
    const document = await createDocument(applicant)

    const response = await applicant.delete(`${API}/documents/${document.id}`)

    expectError(response, 404, 'not_found')
    expectStatus(await applicant.get(`${API}/documents/${document.id}`), 200)
  })
})
