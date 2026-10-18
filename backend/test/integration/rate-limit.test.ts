import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { buildApp } from '../../src/app.js'
import { loadEnvironment } from '../../src/config/env.js'
import {
  ALLOWED_ORIGIN,
  API,
  TEST_DATABASE_URL,
  createTestApi,
  expectError,
  expectStatus,
  uniqueEmail,
  type TestApi,
} from '../helpers/api.js'
import { closeTestDatabase } from '../helpers/database.js'

/**
 * The brute-force budget on the authentication endpoints, and the client
 * address it is charged to.
 *
 * Each case builds its own application over the shared database, because the
 * limiter keeps its counters in the instance. That is what makes it possible to
 * spend a budget in one test without disturbing the next.
 */

let api: TestApi

beforeAll(async () => {
  // A high default budget: this file's subject is limited by its own instances,
  // not by the shared one.
  api = await createTestApi({ AUTH_RATE_LIMIT_MAX: '10000' })
})

afterAll(async () => {
  await api.close()
  await closeTestDatabase()
})

/** Builds a second application over the same database, with its own counters. */
async function withApp<T>(
  overrides: Record<string, string>,
  run: (app: FastifyInstance) => Promise<T>,
): Promise<T> {
  const app = buildApp({
    env: loadEnvironment({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DATABASE_URL: TEST_DATABASE_URL,
      UPLOAD_DIR: api.uploadDir,
      CORS_ALLOWED_ORIGINS: ALLOWED_ORIGIN,
      AUTH_RATE_LIMIT_MAX: '10000',
      EXTRACTION_PROVIDER: 'mock',
      ...overrides,
    }),
    database: api.database,
  })

  await app.ready()
  try {
    return await run(app)
  } finally {
    await app.close()
  }
}

/** One login attempt with a deliberately wrong password. */
async function attemptLogin(
  app: FastifyInstance,
  email: string,
  forwardedFor?: string,
): Promise<{ statusCode: number; body: string; retryAfter: string | undefined }> {
  const response = await app.inject({
    method: 'POST',
    url: `${API}/auth/login`,
    headers: {
      'content-type': 'application/json',
      ...(forwardedFor === undefined ? {} : { 'x-forwarded-for': forwardedFor }),
    },
    payload: { email, password: 'definitely-not-the-password' },
  })

  return {
    statusCode: response.statusCode,
    body: response.body,
    retryAfter: response.headers['retry-after'] as string | undefined,
  }
}

describe('the authentication rate limit', () => {
  it('answers normally until the budget is spent, then refuses', async () => {
    await withApp({ AUTH_RATE_LIMIT_MAX: '3' }, async (app) => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const response = await attemptLogin(app, `budget-${attempt}@example.test`)
        expect(response.statusCode).toBe(401)
      }

      const refused = await attemptLogin(app, 'budget-3@example.test')
      expect(refused.statusCode).toBe(429)

      const body = JSON.parse(refused.body) as {
        error: { code: string; message: string }
      }
      // A stable code, so a client can distinguish throttling from a bad password.
      expect(body.error.code).toBe('rate_limited')
      expect(body.error.message).toContain('Try again in')
      // The wait is machine-readable as well as prose.
      expect(refused.retryAfter).toBeDefined()
      expect(Number(refused.retryAfter)).toBeGreaterThan(0)
    })
  })

  it('is a budget per address on one route, not one per account', async () => {
    await withApp({ AUTH_RATE_LIMIT_MAX: '2' }, async (app) => {
      // Two different accounts, one address: the point of the limit is that
      // trying another account does not buy another pair of attempts.
      expect((await attemptLogin(app, 'first@example.test')).statusCode).toBe(401)
      expect((await attemptLogin(app, 'second@example.test')).statusCode).toBe(401)

      expect((await attemptLogin(app, 'third@example.test')).statusCode).toBe(429)
    })
  })

  it('counts each limited route separately, so a spent login budget does not block registration', async () => {
    await withApp({ AUTH_RATE_LIMIT_MAX: '2' }, async (app) => {
      const register = async (): Promise<number> => {
        const response = await app.inject({
          method: 'POST',
          url: `${API}/auth/register`,
          headers: { 'content-type': 'application/json', origin: ALLOWED_ORIGIN },
          payload: {
            email: uniqueEmail('rate-limit'),
            password: 'correct-horse-battery-staple',
            displayName: 'Registered under a spent login budget',
          },
        })
        return response.statusCode
      }

      // Spend the login budget completely.
      await attemptLogin(app, 'spent-one@example.test')
      await attemptLogin(app, 'spent-two@example.test')
      expect((await attemptLogin(app, 'spent-three@example.test')).statusCode).toBe(429)

      // Registration has its own budget, so a legitimate sign-up is not blocked
      // by somebody else's failed sign-in attempts from the same network.
      expect(await register()).toBe(201)
      expect(await register()).toBe(201)
      expect(await register()).toBe(429)
    })
  })

  it('does not let a forged forwarded address buy a fresh allowance', async () => {
    await withApp({ AUTH_RATE_LIMIT_MAX: '2' }, async (app) => {
      // No proxy is configured, so this header describes nothing and the real
      // socket address is charged.
      expect(
        (await attemptLogin(app, 'one@example.test', '203.0.113.10')).statusCode,
      ).toBe(401)
      expect(
        (await attemptLogin(app, 'two@example.test', '203.0.113.11')).statusCode,
      ).toBe(401)
      expect(
        (await attemptLogin(app, 'three@example.test', '203.0.113.12')).statusCode,
      ).toBe(429)
    })
  })

  it('charges the forwarded address only when the deployment declares a proxy', async () => {
    await withApp(
      { AUTH_RATE_LIMIT_MAX: '2', TRUST_PROXY: 'true' },
      async (app) => {
        // With trust stated, each distinct forwarded address is its own client.
        // This documents the difference: the header is honoured because a proxy
        // in front of the process is set up to strip and rewrite it.
        expect(
          (await attemptLogin(app, 'one@example.test', '203.0.113.10')).statusCode,
        ).toBe(401)
        expect(
          (await attemptLogin(app, 'two@example.test', '203.0.113.11')).statusCode,
        ).toBe(401)
        expect(
          (await attemptLogin(app, 'three@example.test', '203.0.113.12')).statusCode,
        ).toBe(401)
      },
    )
  })

  it('does not throttle the rest of the API', async () => {
    await withApp({ AUTH_RATE_LIMIT_MAX: '1' }, async (app) => {
      expect((await attemptLogin(app, 'only@example.test')).statusCode).toBe(401)
      expect((await attemptLogin(app, 'only@example.test')).statusCode).toBe(429)

      // The budget applies to the routes that opted in, so ordinary reads are
      // unaffected by a colleague's failed sign-in attempts.
      expectStatus(await app.inject({ method: 'GET', url: '/health/live' }), 200)

      const unauthenticatedRead = await app.inject({
        method: 'GET',
        url: `${API}/parcels`,
      })
      // Unauthenticated, not throttled.
      expectError(unauthenticatedRead, 401, 'unauthenticated')
    })
  })

  it('keeps proxy trust off unless the environment asks for it', async () => {
    // The default is the safe one: the process describes the socket it sees,
    // and nothing a caller sends can change that. The two cases above are the
    // behavioural proof; this one states where the default comes from.
    const env = loadEnvironment({
      NODE_ENV: 'test',
      DATABASE_URL: TEST_DATABASE_URL,
      UPLOAD_DIR: api.uploadDir,
    })
    expect(env.TRUST_PROXY).toBe(false)
  })
})
