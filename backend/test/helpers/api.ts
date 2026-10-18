import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { FastifyInstance, LightMyRequestResponse } from 'fastify'
import { expect } from 'vitest'

import { buildApp } from '../../src/app.js'
import {
  CSRF_COOKIE_NAME,
  SESSION_COOKIE_NAME,
} from '../../src/config/constants.js'
import { loadEnvironment, type Environment } from '../../src/config/env.js'
import type { Database } from '../../src/db/client.js'
import type { UserRole } from '../../src/db/schema/enums.js'
import { systemActor } from '../../src/services/audit.js'
import {
  createSession,
  provisionPrivilegedAccount,
  registerApplicant,
  resolveSessionToken,
} from '../../src/services/auth.js'
import { closeTestDatabase, initializeTestDatabase } from './database.js'

/**
 * Shared HTTP test harness.
 *
 * Every integration test drives the real application through `app.inject()`,
 * against the guarded `_test` database. Nothing is stubbed except, where a test
 * says so explicitly, the outbound provider transport.
 *
 * Three deliberate choices:
 *
 * - The rate limiter is effectively disabled by default. Authentication is rate
 *   limited on purpose, but a test suite that signs in dozens of times would
 *   trip it constantly. The limit is configured per test file, and the file that
 *   actually tests limiting sets a low ceiling.
 * - Uploads go to a per-file temporary directory that is removed on close, so a
 *   test run never writes into the repository or into the developer's real
 *   upload directory.
 * - The CSRF token and cookie are attached automatically, because a client that
 *   matches the browser contract is the normal case; tests that probe forgery
 *   protection turn the pieces off one at a time.
 */

export const TEST_DATABASE_URL =
  process.env['TEST_DATABASE_URL'] ??
  'postgres://bhoomitrace:bhoomitrace@127.0.0.1:5433/bhoomitrace_test'

/** An origin the application is configured to accept. */
export const ALLOWED_ORIGIN = 'http://localhost:5173'

/** An origin that must be refused, because it is not on the allowlist. */
export const FOREIGN_ORIGIN = 'https://attacker.example'

/** Base path of the versioned API. */
export const API = '/api/v1'

export interface TestApi {
  app: FastifyInstance
  env: Environment
  database: Database
  uploadDir: string
  /** Closes the server and removes the temporary upload directory. */
  close(): Promise<void>
}

export async function createTestApi(
  overrides: Record<string, string> = {},
): Promise<TestApi> {
  const database = await initializeTestDatabase()
  const uploadDir = await mkdtemp(join(tmpdir(), 'bhoomitrace-test-uploads-'))

  const env = loadEnvironment({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: TEST_DATABASE_URL,
    UPLOAD_DIR: uploadDir,
    CORS_ALLOWED_ORIGINS: ALLOWED_ORIGIN,
    AUTH_RATE_LIMIT_MAX: '10000',
    EXTRACTION_PROVIDER: 'mock',
    ...overrides,
  })

  const app = buildApp({ env, database })
  await app.ready()

  return {
    app,
    env,
    database,
    uploadDir,
    async close() {
      await app.close()
      await rm(uploadDir, { recursive: true, force: true })
      await closeTestDatabase()
    },
  }
}

/* -------------------------------------------------------------------------- */
/* Accounts                                                                    */
/* -------------------------------------------------------------------------- */

export interface TestAccount {
  id: string
  email: string
  displayName: string
  role: UserRole
  password: string
}

let accountSequence = 0

/** A password that satisfies the length policy without being a real secret. */
export const TEST_PASSWORD = 'correct-horse-battery-staple'

/** A fresh email address, so runs never collide on the unique index. */
export function uniqueEmail(prefix = 'account'): string {
  accountSequence += 1
  return `${prefix}-${Date.now().toString(36)}-${accountSequence}-${randomUUID().slice(0, 8)}@example.test`
}

/**
 * Creates an account in the requested role.
 *
 * Applicants go through the real registration path. Reviewers and administrators
 * go through `provisionPrivilegedAccount`, which is the same code the bootstrap
 * CLI uses and the only path in the codebase that can write a non-applicant
 * role.
 */
export async function createAccount(
  database: Database,
  role: UserRole,
  overrides: Partial<Pick<TestAccount, 'email' | 'displayName' | 'password'>> = {},
): Promise<TestAccount> {
  const email = overrides.email ?? uniqueEmail(role)
  const displayName = overrides.displayName ?? `${role} test account`
  const password = overrides.password ?? TEST_PASSWORD

  if (role === 'applicant') {
    const user = await registerApplicant(database, { email, password, displayName })
    return { id: user.id, email: user.email, displayName: user.displayName, role: user.role, password }
  }

  const result = await provisionPrivilegedAccount(database, {
    email,
    password,
    displayName,
    role,
    actor: systemActor('test-suite'),
  })

  return {
    id: result.user.id,
    email: result.user.email,
    displayName: result.user.displayName,
    role: result.user.role,
    password,
  }
}

/* -------------------------------------------------------------------------- */
/* Clients                                                                     */
/* -------------------------------------------------------------------------- */

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'

export interface TestCallOptions {
  method?: HttpMethod
  url: string
  payload?: unknown
  /** Send the session cookie. Defaults to true. */
  withSessionCookie?: boolean
  /** Send the CSRF cookie and header. Defaults to true. */
  withCsrf?: boolean
  /**
   * `Origin` header value. Defaults to the allowed origin; `null` sends none,
   * which is how a non-browser client is modelled.
   */
  origin?: string | null
  headers?: Record<string, string>
  /** Replaces the entire `Cookie` header. */
  cookieHeader?: string
  /** Sends a raw body instead of JSON, for multipart and binary uploads. */
  rawBody?: Buffer
  contentType?: string
}

export interface TestClient {
  account: TestAccount
  sessionId: string
  sessionToken: string
  csrfToken: string
  call(options: TestCallOptions): Promise<LightMyRequestResponse>
  get(url: string, options?: Omit<TestCallOptions, 'method' | 'url'>): Promise<LightMyRequestResponse>
  post(
    url: string,
    payload?: unknown,
    options?: Omit<TestCallOptions, 'method' | 'url' | 'payload'>,
  ): Promise<LightMyRequestResponse>
  patch(
    url: string,
    payload?: unknown,
    options?: Omit<TestCallOptions, 'method' | 'url' | 'payload'>,
  ): Promise<LightMyRequestResponse>
  delete(url: string, options?: Omit<TestCallOptions, 'method' | 'url'>): Promise<LightMyRequestResponse>
}

/** Reads one cookie value out of a response's `Set-Cookie` headers. */
export function readResponseCookie(
  response: LightMyRequestResponse,
  name: string,
): string {
  const found = response.cookies.find((cookie) => cookie.name === name)
  if (found === undefined) {
    throw new Error(
      `Expected the response to set cookie "${name}", but it did not. Body: ${response.body}`,
    )
  }
  return found.value
}

/**
 * Returns the raw `Set-Cookie` header for a cookie.
 *
 * Attribute assertions (`HttpOnly`, `SameSite`, `Path`, `Secure`) are made
 * against the header text, because that is what the browser actually receives;
 * a parsed cookie object does not always expose every attribute.
 */
export function rawSetCookie(
  response: LightMyRequestResponse,
  name: string,
): string | undefined {
  const header = response.headers['set-cookie']
  const values = Array.isArray(header) ? header : header === undefined ? [] : [header]
  return values.find((value) => value.startsWith(`${name}=`))
}

function buildClient(
  app: FastifyInstance,
  account: TestAccount,
  session: { id: string; token: string; csrfToken: string },
): TestClient {
  const client: TestClient = {
    account,
    sessionId: session.id,
    sessionToken: session.token,
    csrfToken: session.csrfToken,

    async call(options) {
      const headers: Record<string, string> = { ...options.headers }

      const origin = options.origin === undefined ? ALLOWED_ORIGIN : options.origin
      if (origin !== null) headers['origin'] = origin

      if (options.withCsrf !== false) headers['x-csrf-token'] = session.csrfToken

      if (options.cookieHeader !== undefined) {
        headers['cookie'] = options.cookieHeader
      } else {
        const parts: string[] = []
        if (options.withSessionCookie !== false) {
          parts.push(`${SESSION_COOKIE_NAME}=${session.token}`)
        }
        if (options.withCsrf !== false) {
          parts.push(`${CSRF_COOKIE_NAME}=${session.csrfToken}`)
        }
        if (parts.length > 0) headers['cookie'] = parts.join('; ')
      }

      let payload: Buffer | string | undefined
      if (options.rawBody !== undefined) {
        payload = options.rawBody
        headers['content-type'] = options.contentType ?? 'application/octet-stream'
      } else if (options.payload !== undefined) {
        payload = JSON.stringify(options.payload)
        headers['content-type'] = 'application/json'
      }

      return app.inject({
        method: options.method ?? 'GET',
        url: options.url,
        headers,
        ...(payload === undefined ? {} : { payload }),
      })
    },

    get(url, options = {}) {
      return client.call({ ...options, method: 'GET', url })
    },
    post(url, payload, options = {}) {
      return client.call({ ...options, method: 'POST', url, payload })
    },
    patch(url, payload, options = {}) {
      return client.call({ ...options, method: 'PATCH', url, payload })
    },
    delete(url, options = {}) {
      return client.call({ ...options, method: 'DELETE', url })
    },
  }

  return client
}

/**
 * Signs in over HTTP and returns a client carrying the session.
 *
 * Using the real endpoint means every client in the suite is proof that login
 * works, rather than a hand-built session that skips the code path under test.
 */
export async function signIn(
  app: FastifyInstance,
  account: TestAccount,
): Promise<TestClient> {
  const response = await app.inject({
    method: 'POST',
    url: `${API}/auth/login`,
    headers: { 'content-type': 'application/json' },
    payload: { email: account.email, password: account.password },
  })

  if (response.statusCode !== 200) {
    throw new Error(
      `Sign-in failed for ${account.email}: ${response.statusCode} ${response.body}`,
    )
  }

  const sessionToken = readResponseCookie(response, SESSION_COOKIE_NAME)

  // The session identifier is not part of the response body, so it is read back
  // through the same resolution the API itself uses. A test that needs the row
  // (to assert a logout really deleted it) then has a real identifier rather
  // than a guess.
  const resolution = await resolveSessionToken(app.database, sessionToken)
  if (resolution.outcome !== 'active') {
    throw new Error(
      `The session issued to ${account.email} did not resolve as active (${resolution.outcome}).`,
    )
  }

  return buildClient(app, account, {
    id: resolution.session.id,
    token: sessionToken,
    csrfToken: readResponseCookie(response, CSRF_COOKIE_NAME),
  })
}

/** Creates a session directly, without going through the login endpoint. */
export async function openSession(
  database: Database,
  app: FastifyInstance,
  account: TestAccount,
): Promise<TestClient> {
  const session = await createSession(
    database,
    account.id,
    { ttlHours: 12 },
    { userAgent: 'bhoomitrace-test-suite' },
  )

  return buildClient(app, account, {
    id: session.session.id,
    token: session.token,
    csrfToken: session.csrfToken,
  })
}

/* -------------------------------------------------------------------------- */
/* Assertions and fixtures                                                     */
/* -------------------------------------------------------------------------- */

export interface ErrorEnvelopeBody {
  error: {
    code: string
    message: string
    requestId: string
    details?: unknown
  }
}

/** Fails loudly, showing the body, when a response is not the expected status. */
export function expectStatus(
  response: LightMyRequestResponse,
  statusCode: number,
): LightMyRequestResponse {
  if (response.statusCode !== statusCode) {
    expect.fail(
      `Expected status ${statusCode} but received ${response.statusCode}. Body: ${response.body}`,
    )
  }
  return response
}

/** Asserts the standard error envelope, including its machine-readable code. */
export function expectError(
  response: LightMyRequestResponse,
  statusCode: number,
  code: string,
): ErrorEnvelopeBody {
  const actualCode = readErrorCode(response)
  if (response.statusCode !== statusCode || actualCode !== code) {
    expect.fail(
      `Expected ${statusCode} "${code}" but received ${response.statusCode} "${String(actualCode)}". Body: ${response.body}`,
    )
  }

  const body = response.json() as ErrorEnvelopeBody
  expect(typeof body.error.requestId).toBe('string')
  return body
}

function readErrorCode(response: LightMyRequestResponse): string | undefined {
  try {
    const body = JSON.parse(response.body) as { error?: { code?: string } }
    return body.error?.code
  } catch {
    return undefined
  }
}

export interface ParcelBody {
  id: string
  ownerId: string | null
  origin: 'synthetic_demo' | 'user_created'
  lifecycle: 'active' | 'retired'
  survey: string
  khatianNumber: string
  mouza: string
  jlNumber: string
  upazila: string
  district: string
  areaDecimal: string
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

export interface ParcelDraft {
  survey?: string
  khatianNumber?: string
  mouza?: string
  jlNumber?: string
  upazila?: string
  district?: string
  areaDecimal?: string
  shareNumerator?: number
  shareDenominator?: number
  dagNumbers?: string[]
  ownerId?: string | null
}

/**
 * Creates a parcel as the client's account and returns the created record.
 *
 * Defaults are varied per call so that two parcels created in the same test are
 * never accidentally identical; a test that needs specific values passes them.
 */
export async function createParcel(
  client: TestClient,
  draft: ParcelDraft = {},
): Promise<ParcelBody> {
  // Run-unique: earlier runs leave their rows in place (nothing is ever
  // deleted), and the record identity — survey, district, upazila, mouza, JL
  // number, khatian number — is unique in the database.
  const suffix = `${createParcelSequence()}-${randomUUID().slice(0, 8)}`
  const response = await client.post(`${API}/parcels`, {
    survey: draft.survey ?? 'RS',
    khatianNumber: draft.khatianNumber ?? `KH-${suffix}`,
    mouza: draft.mouza ?? 'Test Mouza',
    jlNumber: draft.jlNumber ?? `JL-${suffix}`,
    upazila: draft.upazila ?? 'Test Upazila',
    district: draft.district ?? 'Test District',
    areaDecimal: draft.areaDecimal ?? '120.5000',
    shareNumerator: draft.shareNumerator ?? 1,
    shareDenominator: draft.shareDenominator ?? 2,
    dagNumbers: draft.dagNumbers ?? [`DAG-${suffix}`],
    ...(draft.ownerId === undefined ? {} : { ownerId: draft.ownerId }),
  })

  expectStatus(response, 201)
  return response.json() as ParcelBody
}

let parcelSequence = 0
function createParcelSequence(): number {
  parcelSequence += 1
  return parcelSequence
}

export interface DocumentBody {
  id: string
  ownerId: string | null
  origin: 'synthetic_demo' | 'user_created'
  title: string
  kind: string
  reference: string | null
  pageCount: number | null
  checksumSha256: string | null
  status: string
  contentType: string | null
  byteSize: number | null
  originalFilename: string | null
  hasStoredFile: boolean
  version: number
  createdAt: string
  updatedAt: string
}

/** Registers a metadata-only source document as the client's account. */
export async function createDocument(
  client: TestClient,
  overrides: Partial<{
    title: string
    kind: string
    reference: string | null
    pageCount: number | null
    ownerId: string | null
  }> = {},
): Promise<DocumentBody> {
  const response = await client.post(`${API}/documents`, {
    title: overrides.title ?? 'Test source document',
    kind: overrides.kind ?? 'manual_entry',
    reference: overrides.reference ?? null,
    pageCount: overrides.pageCount ?? 1,
    ...(overrides.ownerId === undefined ? {} : { ownerId: overrides.ownerId }),
  })

  expectStatus(response, 201)
  return response.json() as DocumentBody
}

/** A minimal but structurally valid PDF, enough to pass signature sniffing. */
export function pdfFixture(marker = 'fixture'): Buffer {
  return Buffer.concat([
    Buffer.from('%PDF-1.7\n'),
    Buffer.from(`% ${marker}\n`),
    Buffer.from('1 0 obj\n<< /Type /Catalog >>\nendobj\n'),
    Buffer.from('trailer\n<< /Root 1 0 R >>\n%%EOF\n'),
  ])
}

/** A 1×1 PNG, used as a second accepted type. */
export function pngFixture(): Buffer {
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/wD/AL0AAAAASUVORK5CYII=',
    'base64',
  )
}

/** Builds a single-part multipart/form-data body with a binary file part. */
export function multipartBody(
  filename: string,
  contents: Buffer,
  contentType = 'application/pdf',
): { body: Buffer; contentType: string } {
  const boundary = `----bhoomitrace-${randomUUID()}`
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: ${contentType}\r\n\r\n`,
  )
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`)

  return {
    body: Buffer.concat([head, contents, tail]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  }
}

/**
 * Uploads a file through the real multipart route.
 *
 * The declared content type is always sent as a *plausible lie* (`pdf`), so the
 * tests that pass an unrecognised file prove the signature check is what
 * rejects it, not the declared type.
 */
export async function uploadDocument(
  client: TestClient,
  contents: Buffer,
  options: { title?: string; kind?: string; filename?: string; declaredType?: string; query?: string } = {},
): Promise<LightMyRequestResponse> {
  const title = options.title ?? 'Uploaded source document'
  const kind = options.kind ?? 'manual_entry'
  const query = options.query ?? `title=${encodeURIComponent(title)}&kind=${kind}`
  const { body, contentType } = multipartBody(
    options.filename ?? 'record.pdf',
    contents,
    options.declaredType ?? 'application/pdf',
  )

  return client.post(`${API}/documents/upload?${query}`, undefined, {
    rawBody: body,
    contentType,
  })
}

/** A fresh idempotency key, so repeated runs never collide on the unique index. */
export function uniqueIdempotencyKey(prefix = 'job'): string {
  return `${prefix}-${randomUUID()}`
}

/** A random identifier that is not present in the database. */
export function unknownUuid(): string {
  return randomUUID()
}

export { closeTestDatabase } from './database.js'
