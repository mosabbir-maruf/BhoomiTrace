import { describe, expect, it } from 'vitest'

import {
  EnvironmentValidationError,
  loadEnvironment,
} from '../../src/config/env.js'
import { FallbackExtractionProvider } from '../../src/extraction/external-providers.js'
import { MockExtractionProvider } from '../../src/extraction/mock-provider.js'
import {
  createExtractionProvider,
  describeProvider,
} from '../../src/extraction/registry.js'

/**
 * Choosing a reader from configuration.
 *
 * The registry is where a configuration string becomes the object that will
 * touch a document, so what matters is that the two are never confused: a
 * synthetic double must be reported as one, and a real reader must declare what
 * it can read. Nothing here contacts a network.
 */

const BASE = { DATABASE_URL: 'postgres://user:pass@localhost:5432/bhoomitrace' }

describe('createExtractionProvider', () => {
  it('defaults to the synthetic mock and reports it as one', () => {
    const env = loadEnvironment(BASE)
    const provider = createExtractionProvider(env)

    expect(provider).toBeInstanceOf(MockExtractionProvider)
    expect(provider.name).toBe('mock')

    const description = describeProvider(provider)
    // The distinction that keeps fixture output from being mistaken for a read.
    expect(description.readsDocumentContent).toBe(false)
    expect(description.supportedMediaTypes).toBeNull()
    expect(description.requiresCredentials).toBe(false)
  })

  it('builds the intended primary/fallback chain for auto', () => {
    const env = loadEnvironment({
      ...BASE,
      EXTRACTION_PROVIDER: 'auto',
      GEMINI_API_KEY: 'gemini-key',
      GROQ_API_KEY: 'groq-key',
    })

    const provider = createExtractionProvider(env)

    expect(provider).toBeInstanceOf(FallbackExtractionProvider)
    expect(provider.name).toBe('fallback(gemini>groq)')
    expect(provider.readsDocumentContent).toBe(true)
    // The union of what its members can read: PDFs from Gemini, images from both.
    expect(provider.supportedMediaTypes).toEqual([
      'application/pdf',
      'image/png',
      'image/jpeg',
    ])
  })

  it('exposes only what a reader declares, and no credential', () => {
    const env = loadEnvironment({
      ...BASE,
      EXTRACTION_PROVIDER: 'gemini',
      GEMINI_API_KEY: 'super-secret-gemini-key',
      GEMINI_MODEL: 'gemini-2.5-flash',
    })

    const description = describeProvider(createExtractionProvider(env))

    expect(description.name).toBe('gemini')
    expect(description.model).toBe('gemini-2.5-flash')
    expect(description.readsDocumentContent).toBe(true)
    expect(description.supportedMediaTypes).toContain('application/pdf')
    expect(description.configured).toBe(true)
    expect(JSON.stringify(description)).not.toContain('super-secret-gemini-key')
  })

  it('never offers a PDF to the image-only reader', () => {
    const env = loadEnvironment({
      ...BASE,
      EXTRACTION_PROVIDER: 'groq',
      GROQ_API_KEY: 'groq-key',
    })

    const description = describeProvider(createExtractionProvider(env))

    expect(description.name).toBe('groq')
    expect(description.readsDocumentContent).toBe(true)
    expect(description.supportedMediaTypes).toEqual(['image/png', 'image/jpeg'])
    // Groq has no document input, so a PDF is not in what it can read.
    expect(description.supportedMediaTypes).not.toContain('application/pdf')
  })

  it('refuses to start a named external reader with no credential', () => {
    // The configuration is the first line of defence: a named reader without a
    // key is a typo, not a deployment. `describeProvider` would report it as
    // unconfigured, but this never gets that far.
    expect(() =>
      loadEnvironment({ ...BASE, EXTRACTION_PROVIDER: 'groq' }),
    ).toThrow(EnvironmentValidationError)
    expect(() =>
      loadEnvironment({ ...BASE, EXTRACTION_PROVIDER: 'gemini' }),
    ).toThrow(EnvironmentValidationError)
  })

  it('reports an unconfigured reader as unconfigured rather than as usable', () => {
    const env = loadEnvironment({
      ...BASE,
      EXTRACTION_PROVIDER: 'groq',
      GROQ_API_KEY: 'groq-key',
    })
    // Constructed with the key stripped, which the schema would not have
    // allowed: the description still tells the truth about it.
    const description = describeProvider({
      ...createExtractionProvider(env),
      isConfigured: () => false,
    })

    expect(description.configured).toBe(false)
    expect(description.requiresCredentials).toBe(true)
  })
})
