import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { buildApp } from '../../src/app.js'
import { loadEnvironment } from '../../src/config/env.js'
import { createDatabase, type Database } from '../../src/db/client.js'
import { closeTestDatabase, initializeTestDatabase } from '../helpers/database.js'

const TEST_ENV = loadEnvironment({
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  DATABASE_URL:
    process.env['TEST_DATABASE_URL'] ??
    'postgres://bhoomitrace:bhoomitrace@127.0.0.1:5433/bhoomitrace_test',
})

let database: Database
let app: ReturnType<typeof buildApp>

beforeAll(async () => {
  database = await initializeTestDatabase()
  app = buildApp({ env: TEST_ENV, database })
  await app.ready()
})

afterAll(async () => {
  await app.close()
  await closeTestDatabase()
})

describe('GET /health/live', () => {
  it('reports process liveness without touching the database', async () => {
    const response = await app.inject({ method: 'GET', url: '/health/live' })

    expect(response.statusCode).toBe(200)
    const body = response.json() as Record<string, unknown>
    expect(body['status']).toBe('ok')
    expect(body['service']).toBe('bhoomitrace-backend')
    expect(body['checks']).toBeUndefined()
  })
})

describe('GET /health', () => {
  it('reports readiness with database latency', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' })

    expect(response.statusCode).toBe(200)
    const body = response.json() as {
      status: string
      checks: { database: { status: string; latencyMs: number } }
    }

    expect(body.status).toBe('ok')
    expect(body.checks.database.status).toBe('up')
    expect(body.checks.database.latencyMs).toBeGreaterThanOrEqual(0)
  })

  it('returns 503 and leaks no connection detail when the database is down', async () => {
    const unreachable = createDatabase({
      connectionString:
        'postgres://nobody:nobody@127.0.0.1:59999/does_not_exist',
      connectionTimeoutMs: 300,
      poolMax: 2,
      applicationName: 'bhoomitrace-backend-test-unreachable',
    })
    const degradedApp = buildApp({ env: TEST_ENV, database: unreachable })
    await degradedApp.ready()

    try {
      const response = await degradedApp.inject({ method: 'GET', url: '/health' })
      expect(response.statusCode).toBe(503)

      const body = response.json() as {
        status: string
        checks: { database: { status: string } }
      }
      expect(body.status).toBe('unavailable')
      expect(body.checks.database.status).toBe('down')
      expect(response.body).not.toContain('ECONNREFUSED')
      expect(response.body).not.toContain('nobody')
    } finally {
      await degradedApp.close()
      await unreachable.close()
    }
  })
})
