import { describe, expect, it } from 'vitest'

import {
  FallbackExtractionProvider,
  GeminiExtractionProvider,
  GroqExtractionProvider,
  type FetchImplementation,
} from '../../src/extraction/external-providers.js'
import {
  ExtractionProviderError,
  type ExtractionRequest,
} from '../../src/extraction/provider.js'

/**
 * External reader adapters.
 *
 * No test here touches the network. The transport is injected, so the assertions
 * are about the request we build and the response we accept — the two places
 * where an adapter can quietly misbehave: sending a document somewhere it should
 * not, or turning a failure into a successful empty read.
 */

const REQUEST: ExtractionRequest = {
  sourceDocumentId: 'b1000000-0000-4000-8000-000000000001',
  title: 'RS khatian 104',
  reference: 'DEMO-RS-104',
  pageCount: 1,
  fields: ['khatian', 'area'],
}

interface CapturedCall {
  url: string
  method: string
  headers: Record<string, string>
  body: string
}

/** A transport that always answers with the given status and body. */
function transport(
  respond: (call: CapturedCall) => { ok?: boolean; status: number; body: string },
  capture?: CapturedCall[],
): FetchImplementation {
  return async (url, init) => {
    const call: CapturedCall = {
      url,
      method: init.method,
      headers: init.headers,
      body: init.body,
    }
    capture?.push(call)
    const result = respond(call)

    return {
      ok: result.ok ?? (result.status >= 200 && result.status < 300),
      status: result.status,
      text: async () => result.body,
    }
  }
}

const geminiOptions = {
  apiKey: 'gemini-test-key',
  model: 'gemini-test-model',
  timeoutMs: 5_000,
}

const groqOptions = {
  apiKey: 'groq-test-key',
  model: 'groq-test-model',
  timeoutMs: 5_000,
}

/** The shape Gemini returns: JSON as a text part of the first candidate. */
function geminiEnvelope(json: unknown): string {
  return JSON.stringify({
    candidates: [{ content: { parts: [{ text: JSON.stringify(json) }] } }],
  })
}

/** The shape Groq returns: JSON as the content of the first choice. */
function groqEnvelope(json: unknown): string {
  return JSON.stringify({
    choices: [{ message: { content: JSON.stringify(json) } }],
  })
}

describe('GeminiExtractionProvider', () => {
  it('reports itself as unconfigured without a key', () => {
    const provider = new GeminiExtractionProvider({ ...geminiOptions, apiKey: '' })
    expect(provider.isConfigured()).toBe(false)
  })

  it('refuses to run when unconfigured rather than returning empty readings', async () => {
    const provider = new GeminiExtractionProvider({ ...geminiOptions, apiKey: '' })

    await expect(provider.extract(REQUEST)).rejects.toBeInstanceOf(ExtractionProviderError)
  })

  it('posts the prompt and the key to the model endpoint', async () => {
    const calls: CapturedCall[] = []
    const provider = new GeminiExtractionProvider({
      ...geminiOptions,
      fetchImpl: transport(
        () => ({ status: 200, body: geminiEnvelope({ fields: [] }) }),
        calls,
      ),
    })

    await provider.extract(REQUEST)

    const call = calls[0]
    expect(call?.method).toBe('POST')
    expect(call?.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-test-model:generateContent',
    )
    expect(call?.headers['x-goog-api-key']).toBe('gemini-test-key')
    expect(call?.body).toContain('khatian, area')
    expect(call?.body).toContain('RS khatian 104')
  })

  it('maps readable fields, keeping a reported confidence and location', async () => {
    const provider = new GeminiExtractionProvider({
      ...geminiOptions,
      fetchImpl: transport(() => ({
        status: 200,
        body: geminiEnvelope({
          fields: [
            {
              field: 'area',
              value: '125.0000',
              confidence: 0.82,
              unclear: false,
              pageNumber: 1,
              pageReference: 'তফসিল, ঘর ৩',
              boundingBox: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
            },
          ],
        }),
      })),
    })

    const result = await provider.extract(REQUEST)
    const area = result.fields.find((field) => field.field === 'area')
    const khatian = result.fields.find((field) => field.field === 'khatian')

    expect(result.provider).toBe('gemini')
    expect(result.model).toBe('gemini-test-model')
    expect(area).toMatchObject({
      value: '125.0000',
      confidence: 0.82,
      isUnclear: false,
      pageNumber: 1,
      pageReference: 'তফসিল, ঘর ৩',
    })
    expect(area?.boundingBox).toEqual({ x: 0.1, y: 0.2, width: 0.3, height: 0.4 })

    // A requested field the model simply did not mention is unread, not empty.
    expect(khatian).toMatchObject({ value: '', isUnclear: true, confidence: null })
  })

  it('treats a stated unclear field as unclear even when a value was returned', async () => {
    const provider = new GeminiExtractionProvider({
      ...geminiOptions,
      fetchImpl: transport(() => ({
        status: 200,
        body: geminiEnvelope({
          fields: [{ field: 'area', value: '১২৫ (অস্পষ্ট)', unclear: true }],
        }),
      })),
    })

    const result = await provider.extract(REQUEST)
    const area = result.fields.find((field) => field.field === 'area')

    expect(area?.isUnclear).toBe(true)
    // The raw text is preserved; nothing is invented to fill the gap.
    expect(area?.value).toBe('১২৫ (অস্পষ্ট)')
  })

  it('never fabricates a confidence when the model omits one', async () => {
    const provider = new GeminiExtractionProvider({
      ...geminiOptions,
      fetchImpl: transport(() => ({
        status: 200,
        body: geminiEnvelope({ fields: [{ field: 'area', value: '1.0000' }] }),
      })),
    })

    const result = await provider.extract(REQUEST)
    expect(result.fields.find((field) => field.field === 'area')?.confidence).toBeNull()
  })

  it('discards a field it was not asked about, and says so', async () => {
    const provider = new GeminiExtractionProvider({
      ...geminiOptions,
      fetchImpl: transport(() => ({
        status: 200,
        body: geminiEnvelope({
          fields: [
            { field: 'khatian', value: '104' },
            { field: 'owner', value: 'someone' },
          ],
        }),
      })),
    })

    const result = await provider.extract(REQUEST)

    expect(result.fields.map((field) => field.field)).toEqual(['khatian', 'area'])
    expect(result.warnings.join(' ')).toContain('owner')
  })

  it('fails loudly on a non-success status, quoting only the status', async () => {
    const provider = new GeminiExtractionProvider({
      ...geminiOptions,
      fetchImpl: transport(() => ({
        status: 429,
        body: 'document text that must not be propagated',
      })),
    })

    const error = await provider.extract(REQUEST).catch((thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(ExtractionProviderError)
    expect((error as ExtractionProviderError).retryable).toBe(true)
    expect((error as ExtractionProviderError).message).toContain('429')
    expect((error as ExtractionProviderError).message).not.toContain('document text')
  })

  it('fails when the provider body is not JSON', async () => {
    const provider = new GeminiExtractionProvider({
      ...geminiOptions,
      fetchImpl: transport(() => ({ status: 200, body: '<html>gateway</html>' })),
    })

    await expect(provider.extract(REQUEST)).rejects.toThrow(/not JSON/)
  })

  it('fails when the response has no text part', async () => {
    const provider = new GeminiExtractionProvider({
      ...geminiOptions,
      fetchImpl: transport(() => ({
        status: 200,
        body: JSON.stringify({ candidates: [{ content: { parts: [] } }] }),
      })),
    })

    await expect(provider.extract(REQUEST)).rejects.toThrow(/no text part/)
  })

  it('fails when the model payload does not match the expected schema', async () => {
    const provider = new GeminiExtractionProvider({
      ...geminiOptions,
      fetchImpl: transport(() => ({
        status: 200,
        body: geminiEnvelope({ fields: [{ field: 'area', confidence: 4 }] }),
      })),
    })

    await expect(provider.extract(REQUEST)).rejects.toThrow(/schema/)
  })

  it('reports a timeout as retryable rather than as an empty read', async () => {
    const aborting: FetchImplementation = async (_url, init) => {
      const error = new Error('aborted')
      error.name = 'AbortError'
      void init.signal
      throw error
    }
    const provider = new GeminiExtractionProvider({ ...geminiOptions, fetchImpl: aborting })

    const error = await provider.extract(REQUEST).catch((thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(ExtractionProviderError)
    expect((error as ExtractionProviderError).retryable).toBe(true)
    expect((error as ExtractionProviderError).message).toContain('did not respond')
  })
})

describe('GroqExtractionProvider', () => {
  it('posts an OpenAI-compatible chat completion with a bearer token', async () => {
    const calls: CapturedCall[] = []
    const provider = new GroqExtractionProvider({
      ...groqOptions,
      fetchImpl: transport(
        () => ({ status: 200, body: groqEnvelope({ fields: [{ field: 'khatian', value: '104' }] }) }),
        calls,
      ),
    })

    const result = await provider.extract(REQUEST)

    expect(calls[0]?.url).toBe('https://api.groq.com/openai/v1/chat/completions')
    expect(calls[0]?.headers['authorization']).toBe('Bearer groq-test-key')
    expect(calls[0]?.body).toContain('groq-test-model')
    expect(result.fields.find((field) => field.field === 'khatian')?.value).toBe('104')
  })

  it('fails when the response has no message content', async () => {
    const provider = new GroqExtractionProvider({
      ...groqOptions,
      fetchImpl: transport(() => ({
        status: 200,
        body: JSON.stringify({ choices: [{ message: {} }] }),
      })),
    })

    await expect(provider.extract(REQUEST)).rejects.toThrow(/no message content/)
  })
})

describe('FallbackExtractionProvider', () => {
  it('uses the primary provider when it works', async () => {
    const gemini = new GeminiExtractionProvider({
      ...geminiOptions,
      fetchImpl: transport(() => ({
        status: 200,
        body: geminiEnvelope({ fields: [{ field: 'khatian', value: 'from-gemini' }] }),
      })),
    })
    const groq = new GroqExtractionProvider({
      ...groqOptions,
      fetchImpl: transport(() => ({ status: 200, body: groqEnvelope({ fields: [] }) })),
    })

    const result = await new FallbackExtractionProvider([gemini, groq]).extract(REQUEST)

    expect(result.provider).toBe('gemini')
    expect(result.fields[0]?.value).toBe('from-gemini')
  })

  it('falls back to the secondary provider when the primary fails', async () => {
    const gemini = new GeminiExtractionProvider({
      ...geminiOptions,
      fetchImpl: transport(() => ({ status: 500, body: 'upstream error' })),
    })
    const groq = new GroqExtractionProvider({
      ...groqOptions,
      fetchImpl: transport(() => ({
        status: 200,
        body: groqEnvelope({ fields: [{ field: 'khatian', value: 'from-groq' }] }),
      })),
    })

    const result = await new FallbackExtractionProvider([gemini, groq]).extract(REQUEST)

    expect(result.provider).toBe('groq')
    expect(result.fields.find((field) => field.field === 'khatian')?.value).toBe('from-groq')
  })

  it('fails when every configured provider fails, never reporting a partial read as success', async () => {
    const gemini = new GeminiExtractionProvider({
      ...geminiOptions,
      fetchImpl: transport(() => ({ status: 503, body: 'nope' })),
    })
    const groq = new GroqExtractionProvider({
      ...groqOptions,
      fetchImpl: transport(() => ({ status: 401, body: 'nope' })),
    })

    const provider = new FallbackExtractionProvider([gemini, groq])
    const error = await provider.extract(REQUEST).catch((thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(ExtractionProviderError)
    expect((error as ExtractionProviderError).message).toContain('gemini')
    expect((error as ExtractionProviderError).message).toContain('groq')
  })

  it('refuses to run when no provider is configured', async () => {
    const provider = new FallbackExtractionProvider([
      new GeminiExtractionProvider({ ...geminiOptions, apiKey: '' }),
      new GroqExtractionProvider({ ...groqOptions, apiKey: '' }),
    ])

    expect(provider.isConfigured()).toBe(false)
    await expect(provider.extract(REQUEST)).rejects.toThrow(/No external extraction provider/)
  })
})
