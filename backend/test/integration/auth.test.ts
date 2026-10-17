import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  SESSION_COOKIE_NAME,
} from '../../src/config/constants.js'
import { createSession, suspendAccount } from '../../src/services/auth.js'
import {
  ALLOWED_ORIGIN,
  API,
  createAccount,
  createTestApi,
  expectError,
  expectStatus,
  FOREIGN_ORIGIN,
  rawSetCookie,
  signIn,
  TEST_PASSWORD,
  type TestApi,
  uniqueEmail,
} from '../helpers/api.js'

/**
 * Authentication, sessions, and request-forgery protection.
 *
 * These tests are written against observable behaviour: the cookies that are
 * set, the status codes returned, and what the body does and does not contain.
 * The two things being protected here are (1) that privilege cannot be
 * self-assigned and (2) that a state-changing request cannot be forged by
 * another site.
 */

let api: TestApi

beforeAll(async () => {
  api = await createTestApi()
})

afterAll(async () => {
  await api.close()
})

/** Reads one cookie out of a response. */
function cookieOf(
  response: { cookies: { name: string; value: string }[] },
  name: string,
): { name: string; value: string } | undefined {
  return response.cookies.find((cookie) => cookie.name === name)
}

describe('POST /auth/register', () => {
  it('creates an applicant and issues both cookies', async () => {
    const response = await api.app.inject({
      method: 'POST',
      url: `${API}/auth/register`,
      headers: { 'content-type': 'application/json' },
      payload: {
        email: uniqueEmail('register'),
        displayName: 'New applicant',
        password: TEST_PASSWORD,
      },
    })

    expectStatus(response, 201)

    const body = response.json() as {
      user: Record<string, unknown>
      csrfToken: string
      expiresAt: string
    }

    expect(body.user['role']).toBe('applicant')
    expect(body.user['status']).toBe('active')
    expect(typeof body.user['id']).toBe('string')
    expect(body.expiresAt).toEqual(expect.any(String))

    // The CSRF token is echoed for clients that cannot read cookies, and the
    // cookie carries the same value so the browser can echo it back.
    const csrfCookie = cookieOf(response, CSRF_COOKIE_NAME)
    expect(csrfCookie?.value).toBe(body.csrfToken)
    expect(cookieOf(response, SESSION_COOKIE_NAME)?.value).toBeTruthy()
  })

  it('sets an HTTP-only session cookie and a readable CSRF cookie', async () => {
    const response = await api.app.inject({
      method: 'POST',
      url: `${API}/auth/register`,
      headers: { 'content-type': 'application/json' },
      payload: {
        email: uniqueEmail('cookies'),
        displayName: 'Cookie inspection',
        password: TEST_PASSWORD,
      },
    })

    const session = rawSetCookie(response, SESSION_COOKIE_NAME)
    const csrf = rawSetCookie(response, CSRF_COOKIE_NAME)

    expect(session).toBeDefined()
    expect(session).toContain('HttpOnly')
    expect(session).toMatch(/SameSite=Lax/i)
    expect(session).toContain('Path=/')
    // Plain HTTP in the test environment: `Secure` would stop the local browser
    // from sending the cookie at all. The production switch is tested in the
    // configuration suite.
    expect(session).not.toContain('Secure')

    // The CSRF cookie must be readable by the browser client.
    expect(csrf).toBeDefined()
    expect(csrf).not.toContain('HttpOnly')
    expect(csrf).toContain('Path=/')
  })

  it('never returns the password or its hash', async () => {
    const password = 'a-very-distinctive-passphrase-123'
    const response = await api.app.inject({
      method: 'POST',
      url: `${API}/auth/register`,
      headers: { 'content-type': 'application/json' },
      payload: {
        email: uniqueEmail('secrets'),
        displayName: 'Secret keeper',
        password,
      },
    })

    expectStatus(response, 201)
    expect(response.body).not.toContain(password)
    expect(response.body).not.toContain('argon2')
    expect(response.body).not.toContain('passwordHash')
    expect(response.body).not.toContain('password_hash')
  })

  it('ignores a role sent in the body, so privilege cannot be self-assigned', async () => {
    const email = uniqueEmail('privilege')
    const response = await api.app.inject({
      method: 'POST',
      url: `${API}/auth/register`,
      headers: { 'content-type': 'application/json' },
      payload: {
        email,
        displayName: 'Would-be reviewer',
        password: TEST_PASSWORD,
        role: 'admin',
        status: 'active',
      },
    })

    expectStatus(response, 201)
    expect((response.json() as { user: { role: string } }).user.role).toBe('applicant')
  })

  it('rejects a password below the policy length', async () => {
    const response = await api.app.inject({
      method: 'POST',
      url: `${API}/auth/register`,
      headers: { 'content-type': 'application/json' },
      payload: {
        email: uniqueEmail('shortpw'),
        displayName: 'Short password',
        password: 'too-short',
      },
    })

    expectError(response, 422, 'validation_failed')
    expect(response.body).not.toContain('too-short')
  })

  it('rejects a malformed email address', async () => {
    const response = await api.app.inject({
      method: 'POST',
      url: `${API}/auth/register`,
      headers: { 'content-type': 'application/json' },
      payload: {
        email: 'not-an-email',
        displayName: 'Bad email',
        password: TEST_PASSWORD,
      },
    })

    expectError(response, 422, 'validation_failed')
  })

  it('refuses a second account on the same address', async () => {
    const email = uniqueEmail('duplicate')
    const payload = { email, displayName: 'First', password: TEST_PASSWORD }

    const first = await api.app.inject({
      method: 'POST',
      url: `${API}/auth/register`,
      headers: { 'content-type': 'application/json' },
      payload,
    })
    expectStatus(first, 201)

    const second = await api.app.inject({
      method: 'POST',
      url: `${API}/auth/register`,
      headers: { 'content-type': 'application/json' },
      payload: { ...payload, displayName: 'Second' },
    })

    expectError(second, 409, 'conflict')
  })
})

describe('POST /auth/login', () => {
  it('signs in with correct credentials', async () => {
    const account = await createAccount(api.database, 'applicant')

    const response = await api.app.inject({
      method: 'POST',
      url: `${API}/auth/login`,
      headers: { 'content-type': 'application/json' },
      payload: { email: account.email, password: account.password },
    })

    expectStatus(response, 200)

    const body = response.json() as { user: { id: string; role: string }; csrfToken: string }
    expect(body.user.id).toBe(account.id)
    expect(body.user.role).toBe('applicant')
    expect(cookieOf(response, CSRF_COOKIE_NAME)?.value).toBe(body.csrfToken)
  })

  it('accepts an address differing only in case', async () => {
    const account = await createAccount(api.database, 'applicant')

    const response = await api.app.inject({
      method: 'POST',
      url: `${API}/auth/login`,
      headers: { 'content-type': 'application/json' },
      payload: { email: account.email.toUpperCase(), password: account.password },
    })

    expectStatus(response, 200)
  })

  it('gives the same answer for a wrong password and an unknown account', async () => {
    const account = await createAccount(api.database, 'applicant')

    const wrongPassword = await api.app.inject({
      method: 'POST',
      url: `${API}/auth/login`,
      headers: { 'content-type': 'application/json' },
      payload: { email: account.email, password: 'definitely-not-the-password' },
    })

    const unknownAccount = await api.app.inject({
      method: 'POST',
      url: `${API}/auth/login`,
      headers: { 'content-type': 'application/json' },
      payload: { email: uniqueEmail('nobody'), password: 'definitely-not-the-password' },
    })

    const first = expectError(wrongPassword, 401, 'unauthenticated')
    const second = expectError(unknownAccount, 401, 'unauthenticated')

    expect(first.error.message).toBe(second.error.message)
    // The message names neither the account nor which half was wrong, and it
    // never echoes the submitted secret.
    expect(first.error.message).not.toContain('exist')
    expect(first.error.message).not.toContain('definitely-not-the-password')
  })

  it('refuses a suspended account with the same generic error', async () => {
    const account = await createAccount(api.database, 'applicant')
    await suspendAccount(api.database, account.id, 'Suspended by the test suite.')

    const response = await api.app.inject({
      method: 'POST',
      url: `${API}/auth/login`,
      headers: { 'content-type': 'application/json' },
      payload: { email: account.email, password: account.password },
    })

    const body = expectError(response, 401, 'unauthenticated')
    expect(body.error.message).not.toContain('suspend')
  })

  it('accepts a browser request from the allowed origin', async () => {
    const account = await createAccount(api.database, 'applicant')

    const response = await api.app.inject({
      method: 'POST',
      url: `${API}/auth/login`,
      headers: { 'content-type': 'application/json', origin: ALLOWED_ORIGIN },
      payload: { email: account.email, password: account.password },
    })

    expectStatus(response, 200)
  })
})

describe('GET /auth/me', () => {
  it('returns the signed-in account without any secret material', async () => {
    const account = await createAccount(api.database, 'applicant')
    const client = await signIn(api.app, account)

    const response = await client.get(`${API}/auth/me`)

    expectStatus(response, 200)
    const body = response.json() as Record<string, unknown>
    expect(body['id']).toBe(account.id)
    expect(body['email']).toBe(account.email)

    // The digest of the session token, and the hash of the password, are never
    // in a response: the serializer only emits declared fields.
    expect(response.body).not.toContain('argon2')
    expect(response.body).not.toContain('tokenHash')
    expect(response.body).not.toContain('csrfTokenHash')
  })

  it('rejects a request with no session cookie', async () => {
    const response = await api.app.inject({ method: 'GET', url: `${API}/auth/me` })

    expectError(response, 401, 'unauthenticated')
  })

  it('rejects an unknown session token and clears the cookies', async () => {
    const response = await api.app.inject({
      method: 'GET',
      url: `${API}/auth/me`,
      headers: { cookie: `${SESSION_COOKIE_NAME}=not-a-real-token` },
    })

    expectError(response, 401, 'unauthenticated')

    // A dead session is dropped, so the client stops presenting it.
    const cleared = cookieOf(response, SESSION_COOKIE_NAME)
    expect(cleared?.value).toBe('')
  })

  it('rejects an expired session', async () => {
    const account = await createAccount(api.database, 'applicant')
    // A negative TTL produces an already-expired row.
    const expired = await createSession(api.database, account.id, { ttlHours: -1 }, {})

    const response = await api.app.inject({
      method: 'GET',
      url: `${API}/auth/me`,
      headers: { cookie: `${SESSION_COOKIE_NAME}=${expired.token}` },
    })

    expectError(response, 401, 'unauthenticated')
  })

  it('rejects a session belonging to a suspended account and revokes it', async () => {
    const account = await createAccount(api.database, 'applicant')
    const client = await signIn(api.app, account)

    await suspendAccount(api.database, account.id, 'Suspended mid-session by the test suite.')

    const response = await client.get(`${API}/auth/me`)
    expectError(response, 401, 'unauthenticated')

    // The suspension takes effect on the next request, not at expiry.
    const afterRevocation = await client.get(`${API}/auth/me`)
    expectError(afterRevocation, 401, 'unauthenticated')
  })
})

describe('POST /auth/logout', () => {
  it('deletes the session so the cookie is worthless afterwards', async () => {
    const account = await createAccount(api.database, 'applicant')
    const client = await signIn(api.app, account)

    const response = await client.post(`${API}/auth/logout`)

    expectStatus(response, 204)
    expect(response.body).toBe('')

    // Both cookies are cleared.
    expect(cookieOf(response, SESSION_COOKIE_NAME)?.value).toBe('')
    expect(cookieOf(response, CSRF_COOKIE_NAME)?.value).toBe('')

    const afterLogout = await client.get(`${API}/auth/me`)
    expectError(afterLogout, 401, 'unauthenticated')
  })

  it('requires a CSRF token even though the caller is signed in', async () => {
    const account = await createAccount(api.database, 'applicant')
    const client = await signIn(api.app, account)

    const response = await client.post(`${API}/auth/logout`, undefined, { withCsrf: false })

    expectError(response, 403, 'forbidden')
  })
})

describe('cross-site request forgery protection', () => {
  it('refuses a state-changing request from an origin that is not allowed', async () => {
    const account = await createAccount(api.database, 'applicant')
    const client = await signIn(api.app, account)

    const response = await client.post(`${API}/auth/logout`, undefined, {
      origin: FOREIGN_ORIGIN,
    })

    expectError(response, 403, 'forbidden')

    // The session must still be alive: the request was rejected, not performed.
    expectStatus(await client.get(`${API}/auth/me`), 200)
  })

  it('refuses a state-changing request whose CSRF header is missing', async () => {
    const account = await createAccount(api.database, 'applicant')
    const client = await signIn(api.app, account)

    const response = await client.post(`${API}/auth/logout`, undefined, {
      withCsrf: false,
      withSessionCookie: true,
    })

    expectError(response, 403, 'forbidden')
  })

  it('refuses a CSRF token that belongs to a different session', async () => {
    const account = await createAccount(api.database, 'applicant')
    const other = await createAccount(api.database, 'applicant')

    const client = await signIn(api.app, account)
    const otherClient = await signIn(api.app, other)

    // A token minted for another session cannot be replayed.
    const response = await client.post(`${API}/auth/logout`, undefined, {
      cookieHeader: `${SESSION_COOKIE_NAME}=${client.sessionToken}; ${CSRF_COOKIE_NAME}=${otherClient.csrfToken}`,
      headers: { [CSRF_HEADER_NAME]: otherClient.csrfToken },
    })

    expectError(response, 403, 'forbidden')
    expectStatus(await client.get(`${API}/auth/me`), 200)
  })

  it('allows a state-changing request with no Origin at all', async () => {
    // A non-browser client (curl, a server-side integration) sends no Origin.
    // It still has to present the CSRF token, which it can, because it holds
    // the cookies itself.
    const account = await createAccount(api.database, 'applicant')
    const client = await signIn(api.app, account)

    const response = await client.post(`${API}/auth/logout`, undefined, { origin: null })

    expectStatus(response, 204)
  })

  it('does not require a CSRF token to sign in', async () => {
    const account = await createAccount(api.database, 'applicant')

    const response = await api.app.inject({
      method: 'POST',
      url: `${API}/auth/login`,
      headers: { 'content-type': 'application/json' },
      payload: { email: account.email, password: account.password },
    })

    expectStatus(response, 200)
  })
})
