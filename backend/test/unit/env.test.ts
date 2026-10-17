import { describe, expect, it } from 'vitest'

import {
  describeEnvironment,
  EnvironmentValidationError,
  loadEnvironment,
  redactConnectionString,
  workerConfigurationNotes,
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

  it('reports whether each external reader is configured without its key', () => {
    const env = loadEnvironment({
      ...MINIMAL_ENV,
      EXTRACTION_PROVIDER: 'gemini',
      GEMINI_API_KEY: 'a-real-looking-key',
      GEMINI_MODEL: 'gemini-2.5-flash',
    })
    const summary = describeEnvironment(env)

    expect(summary.geminiConfigured).toBe(true)
    expect(summary.groqConfigured).toBe(false)
    expect(JSON.stringify(summary)).not.toContain('a-real-looking-key')
  })
})

describe('external reader configuration', () => {
  it('refuses a text-only Groq model with an actionable message', () => {
    // A text-only model would answer from the prompt, and that answer would be
    // stored as a reading. The configuration is refused rather than trusted.
    expect(() =>
      loadEnvironment({
        ...MINIMAL_ENV,
        EXTRACTION_PROVIDER: 'groq',
        GROQ_API_KEY: 'groq-key',
        GROQ_MODEL: 'openai/gpt-oss-20b',
      }),
    ).toThrow(EnvironmentValidationError)

    try {
      loadEnvironment({
        ...MINIMAL_ENV,
        EXTRACTION_PROVIDER: 'groq',
        GROQ_API_KEY: 'groq-key',
        GROQ_MODEL: 'openai/gpt-oss-20b',
      })
    } catch (error) {
      const issues =
        error instanceof EnvironmentValidationError ? error.issues : []
      expect(issues.some((issue) => issue.startsWith('GROQ_MODEL:'))).toBe(true)
      expect(issues.some((issue) => issue.includes('vision-capable'))).toBe(true)
    }
  })

  it('defaults the Groq model to a vision-capable one', () => {
    const env = loadEnvironment({ ...MINIMAL_ENV })
    expect(env.GROQ_MODEL).toBe('qwen/qwen3.8-27b')
  })

  it('bounds the inline content ceiling and requires it to cover an upload', () => {
    expect(loadEnvironment({ ...MINIMAL_ENV }).EXTRACTION_MAX_CONTENT_BYTES).toBe(
      5 * 1024 * 1024,
    )

    // Below the floor: nothing meaningful could be read.
    expect(() =>
      loadEnvironment({ ...MINIMAL_ENV, EXTRACTION_MAX_CONTENT_BYTES: '512' }),
    ).toThrow(EnvironmentValidationError)

    // Above the vendors' inline ceiling.
    expect(() =>
      loadEnvironment({
        ...MINIMAL_ENV,
        EXTRACTION_MAX_CONTENT_BYTES: String(21 * 1024 * 1024),
      }),
    ).toThrow(EnvironmentValidationError)

    // Smaller than an accepted upload: a file the platform took could not be
    // read back, so the configuration is refused.
    expect(() =>
      loadEnvironment({
        ...MINIMAL_ENV,
        UPLOAD_MAX_BYTES: '1000000',
        EXTRACTION_MAX_CONTENT_BYTES: '999999',
      }),
    ).toThrow(EnvironmentValidationError)
  })

  it('notes a lease shorter than the provider timeout, and nothing else', () => {
    const tight = loadEnvironment({
      ...MINIMAL_ENV,
      EXTRACTION_TIMEOUT_MS: '45000',
      WORKER_LEASE_SECONDS: '10',
    })
    const notes = workerConfigurationNotes(tight)

    expect(notes).toHaveLength(1)
    expect(notes[0]).toContain('EXTRACTION_TIMEOUT_MS')

    // The default relationship is consistent, so there is nothing to say: a
    // warning that fires on a sound configuration is noise operators learn to
    // ignore.
    expect(
      workerConfigurationNotes(
        loadEnvironment({
          ...MINIMAL_ENV,
          EXTRACTION_TIMEOUT_MS: '30000',
          WORKER_LEASE_SECONDS: '60',
        }),
      ),
    ).toEqual([])
  })
})
