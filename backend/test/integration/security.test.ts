import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  ALLOWED_ORIGIN,
  API,
  FOREIGN_ORIGIN,
  createAccount,
  createTestApi,
  expectError,
  expectStatus,
  signIn,
  type TestApi,
  type TestClient,
} from '../helpers/api.js'
import { closeTestDatabase } from '../helpers/database.js'

/**
 * The transport-level guarantees: headers, CORS, correlation, and the shape of
 * a failure.
 *
 * These are asserted separately from the domain modules because they apply to
 * every route and are exactly the kind of thing that decays one route at a time.
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

/** Collects every key in a nested JSON value, at any depth. */
function collectKeys(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, into)
    return into
  }
  if (typeof value === 'object' && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      into.add(key)
      collectKeys(child, into)
    }
  }
  return into
}

describe('security headers', () => {
  it('denies framing and object embedding on every API response', async () => {
    const response = await applicant.get(`${API}/parcels?limit=1`)

    expectStatus(response, 200)
    const csp = response.headers['content-security-policy'] ?? ''

    // The two directives that protect an authenticated JSON surface: the
    // response cannot be framed, and nothing can be embedded as a plugin.
    expect(csp).toContain("frame-ancestors 'none'")
    expect(csp).toContain("object-src 'none'")
    expect(csp).toContain("default-src 'self'")
    expect(csp).toContain("form-action 'self'")

    expect(response.headers['x-content-type-options']).toBe('nosniff')
    expect(response.headers['referrer-policy']).toBe('no-referrer')
    expect(response.headers['strict-transport-security']).toContain('max-age=')
    expect(response.headers['cross-origin-opener-policy']).toBe('same-origin')
  })

  it('carries the same headers on the unauthenticated health route', async () => {
    const response = await api.app.inject({ method: 'GET', url: '/health/live' })

    expectStatus(response, 200)
    expect(String(response.headers['content-security-policy'])).toContain(
      "frame-ancestors 'none'",
    )
    expect(response.headers['x-content-type-options']).toBe('nosniff')
  })

  it('serves the documentation page under the same policy', async () => {
    const response = await api.app.inject({ method: 'GET', url: '/docs/' })

    expectStatus(response, 200)
    expect(String(response.headers['content-type'])).toContain('text/html')
    expect(String(response.headers['content-security-policy'])).toContain(
      "frame-ancestors 'none'",
    )
  })
})

describe('cross-origin resource sharing', () => {
  it('reflects the allowed origin and offers no origin to anything else', async () => {
    const allowed = await applicant.get(`${API}/parcels?limit=1`, {
      origin: ALLOWED_ORIGIN,
    })
    expectStatus(allowed, 200)
    expect(allowed.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN)
    expect(allowed.headers['access-control-allow-credentials']).toBe('true')

    // A foreign origin gets no allow-origin header, so the browser refuses to
    // hand the response to the page that asked for it.
    const foreign = await applicant.get(`${API}/parcels?limit=1`, {
      origin: FOREIGN_ORIGIN,
    })
    expectStatus(foreign, 200)
    expect(foreign.headers['access-control-allow-origin']).toBeUndefined()
  })

  it('answers a preflight from the allowed origin with the header contract', async () => {
    const response = await api.app.inject({
      method: 'OPTIONS',
      url: `${API}/parcels`,
      headers: {
        origin: ALLOWED_ORIGIN,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type, x-csrf-token',
      },
    })

    expect(response.statusCode).toBe(204)
    expect(response.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN)
    expect(String(response.headers['access-control-allow-headers'])).toContain(
      'x-csrf-token',
    )
    expect(String(response.headers['access-control-allow-methods'])).toContain('PATCH')
  })

  it('offers no origin to a preflight from anywhere else', async () => {
    const response = await api.app.inject({
      method: 'OPTIONS',
      url: `${API}/parcels`,
      headers: {
        origin: FOREIGN_ORIGIN,
        'access-control-request-method': 'POST',
      },
    })

    expect(response.headers['access-control-allow-origin']).toBeUndefined()
  })

  it('never treats CORS alone as protection: a foreign origin still cannot change anything', async () => {
    const response = await applicant.post(
      `${API}/documents`,
      { title: 'From a foreign origin', kind: 'manual_entry' },
      { origin: FOREIGN_ORIGIN },
    )

    // The origin guard refuses it outright rather than relying on the browser.
    expectError(response, 403, 'forbidden')
  })
})

describe('request correlation', () => {
  it('generates the identifier and ignores one supplied by the caller', async () => {
    const response = await api.app.inject({
      method: 'GET',
      url: `${API}/nothing-here`,
      headers: { 'request-id': 'forged', 'x-request-id': 'also-forged' },
    })

    const body = expectError(response, 404, 'not_found')
    expect(body.error.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    )
    expect(body.error.requestId).not.toContain('forged')

    // The same identifier is returned in the header, so a client can quote it.
    expect(response.headers['x-request-id']).toBe(body.error.requestId)
  })

  it('returns the identifier on a successful response as well', async () => {
    const response = await applicant.get(`${API}/parcels?limit=1`)

    expectStatus(response, 200)
    expect(response.headers['x-request-id']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    )
  })

  it('gives every request its own identifier', async () => {
    const first = await applicant.get(`${API}/parcels?limit=1`)
    const second = await applicant.get(`${API}/parcels?limit=1`)

    expect(first.headers['x-request-id']).not.toBe(second.headers['x-request-id'])
  })
})

describe('failure shape', () => {
  it('envelopes an unmatched route without describing what does exist', async () => {
    const missing = await api.app.inject({ method: 'GET', url: `${API}/parcels/1/secret` })
    expectError(missing, 404, 'not_found')

    // A method a route does not implement is reported the same way, so probing
    // cannot enumerate the surface.
    const wrongMethod = await api.app.inject({
      method: 'PUT',
      url: `${API}/parcels`,
    })
    expectError(wrongMethod, 404, 'not_found')
  })

  it('maps an unsupported content type to a stable code, not a framework code', async () => {
    const response = await api.app.inject({
      method: 'POST',
      url: `${API}/auth/login`,
      headers: { 'content-type': 'application/xml' },
      payload: '<login/>',
    })

    const body = expectError(response, 415, 'unsupported_media_type')
    expect(body.error.code).not.toContain('FST_ERR')
    expect(body.error.message).not.toContain('FST_ERR')
  })

  it('rejects a malformed JSON body without echoing it back', async () => {
    const response = await api.app.inject({
      method: 'POST',
      url: `${API}/auth/login`,
      headers: { 'content-type': 'application/json' },
      payload: '{"email": "someone@example.test", "password": ',
    })

    expect(response.statusCode).toBe(400)
    expect(response.body).not.toContain('password')
  })

  it('never includes a stack trace or a constraint name in an error body', async () => {
    // A duplicate parcel identity is the cheapest way to provoke a database
    // error through the public API.
    const identity = {
      survey: 'BS',
      district: 'Constraint District',
      upazila: 'Constraint Upazila',
      mouza: 'Constraint Mouza',
      jlNumber: `JL-CONSTRAINT-${Date.now().toString(36)}-${Math.random()
        .toString(36)
        .slice(2, 6)}`,
      khatianNumber: '777',
      areaDecimal: '10.0000',
      shareNumerator: 1,
      shareDenominator: 2,
    }

    expectStatus(await applicant.post(`${API}/parcels`, identity), 201)

    const duplicate = await applicant.post(`${API}/parcels`, identity)

    const body = expectError(duplicate, 409, 'conflict')
    expect(body.error.message).not.toContain('duplicate key')
    expect(body.error.message).not.toContain('parcels_identity_unique')
    expect(body.error.message).not.toContain('constraint')
  })
})

describe('the OpenAPI document', () => {
  it('describes the whole route surface', async () => {
    const response = await api.app.inject({ method: 'GET', url: '/docs/json' })

    expectStatus(response, 200)
    const document = response.json() as { paths: Record<string, unknown> }

    expect(Object.keys(document.paths)).toEqual(
      expect.arrayContaining([
        '/api/v1/auth/login',
        '/api/v1/parcels',
        '/api/v1/parcels/{parcelId}/reconciliation',
        '/api/v1/parcels/{parcelId}/readiness',
        '/api/v1/documents/upload',
        '/api/v1/review/queue',
        '/api/v1/jobs',
        '/api/v1/audit-events',
      ]),
    )
  })

  it('declares the cookie and CSRF schemes it actually uses', async () => {
    const response = await api.app.inject({ method: 'GET', url: '/docs/json' })
    const document = response.json() as {
      components: {
        securitySchemes: Record<string, { type: string; in?: string; name?: string }>
      }
    }

    const schemes = document.components.securitySchemes
    expect(schemes['sessionCookie']?.type).toBe('apiKey')
    expect(schemes['sessionCookie']?.in).toBe('cookie')
    expect(schemes['csrfToken']?.type).toBe('apiKey')
    expect(schemes['csrfToken']?.in).toBe('header')
  })

  it('names no secret-bearing field anywhere in the document', async () => {
    const response = await api.app.inject({ method: 'GET', url: '/docs/json' })
    const keys = collectKeys(response.json())

    for (const forbidden of [
      'passwordHash',
      'password_hash',
      'tokenHash',
      'token_hash',
      'csrfTokenHash',
      'csrf_token_hash',
      'storageKey',
      'storage_key',
    ]) {
      expect(keys.has(forbidden)).toBe(false)
    }
  })

  it('documents the download route without promising a JSON body for it', async () => {
    const response = await api.app.inject({ method: 'GET', url: '/docs/json' })
    const document = response.json() as {
      paths: Record<string, { get?: { responses: Record<string, unknown> } }>
    }

    const route = document.paths['/api/v1/documents/{documentId}/file']
    expect(route?.get).toBeDefined()
    // The success body is the stored file, streamed; it is not a JSON object
    // this API can describe, and the route says so by omitting the `200` body.
    expect(route?.get?.responses['200']).toBeUndefined()
    expect(route?.get?.responses['404']).toBeDefined()
  })
})
