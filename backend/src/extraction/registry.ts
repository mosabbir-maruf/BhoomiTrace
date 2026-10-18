import type { Environment } from '../config/env.js'
import {
  FallbackExtractionProvider,
  GeminiExtractionProvider,
  GroqExtractionProvider,
  type FetchImplementation,
} from './external-providers.js'
import {
  DEMO_DOCUMENT_FIXTURES,
  MockExtractionProvider,
  type MockProviderOptions,
} from './mock-provider.js'
import type { ExtractionProvider } from './provider.js'

/**
 * Chooses the extraction provider from validated configuration.
 *
 * `mock` is the default and the only provider that works with no credentials.
 * It is a deterministic test double, not a reader, and the README says so.
 *
 * `gemini` and `groq` select a single external reader; `auto` builds the
 * intended Gemini-primary / Groq-fallback chain. The environment schema has
 * already refused to start an explicitly named provider with no credential, so
 * by the time this runs a configured provider really is configured.
 */

export interface ProviderFactoryOptions {
  /** Extra options for the mock provider, used by tests. */
  mockOptions?: MockProviderOptions
  /** Injected transport for the external adapters, used by tests. */
  fetchImpl?: FetchImplementation
}

export function createExtractionProvider(
  env: Environment,
  options: ProviderFactoryOptions = {},
): ExtractionProvider {
  const geminiOptions = {
    apiKey: env.GEMINI_API_KEY ?? '',
    model: env.GEMINI_MODEL,
    timeoutMs: env.EXTRACTION_TIMEOUT_MS,
    maxContentBytes: env.EXTRACTION_MAX_CONTENT_BYTES,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  }

  const groqOptions = {
    apiKey: env.GROQ_API_KEY ?? '',
    model: env.GROQ_MODEL,
    timeoutMs: env.EXTRACTION_TIMEOUT_MS,
    maxContentBytes: env.EXTRACTION_MAX_CONTENT_BYTES,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  }

  switch (env.EXTRACTION_PROVIDER) {
    case 'mock':
      return new MockExtractionProvider({
        fixtures: DEMO_DOCUMENT_FIXTURES,
        ...options.mockOptions,
      })

    case 'gemini':
      return new GeminiExtractionProvider(geminiOptions)

    case 'groq':
      return new GroqExtractionProvider(groqOptions)

    case 'auto':
      return new FallbackExtractionProvider([
        new GeminiExtractionProvider(geminiOptions),
        new GroqExtractionProvider(groqOptions),
      ])
  }
}

/** The provider's name, for logging and for a job's audit trail. */
export function describeProvider(provider: ExtractionProvider): {
  name: string
  model: string | null
  configured: boolean
  requiresCredentials: boolean
  /** False for the synthetic test double; true for a reader of stored content. */
  readsDocumentContent: boolean
  supportedMediaTypes: readonly string[] | null
} {
  return {
    name: provider.name,
    model: provider.model,
    configured: provider.isConfigured(),
    requiresCredentials: provider.requiresCredentials,
    readsDocumentContent: provider.readsDocumentContent,
    supportedMediaTypes: provider.supportedMediaTypes,
  }
}
