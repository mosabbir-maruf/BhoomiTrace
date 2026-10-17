import { describe, expect, it } from 'vitest'

import {
  describeEnvironment,
  EnvironmentValidationError,
  loadEnvironment,
  redactConnectionString,
} from '../../src/config/env.js'

const MINIMAL_ENV = {
  DATABASE_URL: 'postgres://user:secret-password@localhost:5432/bhoomitrace',
}

describe('loadEnvironment', () => {
  it('applies documented defaults for optional variables', () => {
    const env = loadEnvironment(MINIMAL_ENV)

    expect(env.NODE_ENV).toBe('development')
    expect(env.HOST).toBe('0.0.0.0')
    expect(env.PORT).toBe(3000)
    expect(env.LOG_LEVEL).toBe('info')
    expect(env.DATABASE_POOL_MAX).toBe(10)
    expect(env.DATABASE_CONNECT_TIMEOUT_MS).toBe(5000)
  })

  it('coerces numeric strings', () => {
    const env = loadEnvironment({
      ...MINIMAL_ENV,
      PORT: '8080',
      DATABASE_POOL_MAX: '25',
    })

    expect(env.PORT).toBe(8080)
    expect(env.DATABASE_POOL_MAX).toBe(25)
  })

  it('rejects a missing DATABASE_URL', () => {
    expect(() => loadEnvironment({})).toThrow(EnvironmentValidationError)
  })

  it('rejects a non-PostgreSQL DATABASE_URL', () => {
    let error: unknown
    try {
      loadEnvironment({ DATABASE_URL: 'mysql://user@localhost:3306/db' })
    } catch (caught) {
      error = caught
    }

    expect(error).toBeInstanceOf(EnvironmentValidationError)
    expect((error as EnvironmentValidationError).issues.join('\n')).toContain(
      'DATABASE_URL',
    )
  })

  it('rejects a non-numeric PORT', () => {
    expect(() => loadEnvironment({ ...MINIMAL_ENV, PORT: 'http' })).toThrow(
      EnvironmentValidationError,
    )
  })

  it('rejects an out-of-range PORT', () => {
    expect(() => loadEnvironment({ ...MINIMAL_ENV, PORT: '70000' })).toThrow(
      EnvironmentValidationError,
    )
  })

  it('rejects an unknown LOG_LEVEL', () => {
    expect(() =>
      loadEnvironment({ ...MINIMAL_ENV, LOG_LEVEL: 'chatty' }),
    ).toThrow(EnvironmentValidationError)
  })

  it('rejects an unknown NODE_ENV', () => {
    expect(() =>
      loadEnvironment({ ...MINIMAL_ENV, NODE_ENV: 'staging' }),
    ).toThrow(EnvironmentValidationError)
  })
})

describe('redaction', () => {
  it('removes the password from a connection string', () => {
    const redacted = redactConnectionString(
      'postgres://user:secret-password@localhost:5432/bhoomitrace',
    )

    expect(redacted).not.toContain('secret-password')
    expect(redacted).toContain('user')
  })

  it('never exposes the password through describeEnvironment', () => {
    const env = loadEnvironment(MINIMAL_ENV)
    const summary = JSON.stringify(describeEnvironment(env))

    expect(summary).not.toContain('secret-password')
    expect(summary).toContain('development')
  })
})
