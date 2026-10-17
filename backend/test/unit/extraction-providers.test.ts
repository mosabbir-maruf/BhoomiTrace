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
 * are about the request we build and the response we accept — the places where
 * an adapter can quietly misbehave: sending a document somewhere it should not,
 * answering without ever sending the document, or turning a failure into a
 * successful empty read.
 */

const PDF_BYTES = Buffer.from('%PDF-1.7\n% bhoomitrace test fixture, not a real record\n%%EOF\n', 'utf8')
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02, 0x03])

function requestWith(
  content: ExtractionRequest['content'],
  fields: ExtractionRequest['fields'] = ['khatian', 'area'],
): ExtractionRequest {
  return {
    sourceDocumentId: 'b1000000-0000-4000-8000-000000000001',
    title: 'RS khatian 104',
    reference: 'DEMO-RS-104',
    pageCount: 1,
    fields,
    content,
  }
}

/** A PDF, which Gemini reads and Groq cannot. */
const PDF_REQUEST = requestWith({
  mediaType: 'application/pdf',
  bytes: PDF_BYTES,
  byteSize: PDF_BYTES.byteLength,
  sha256: 'b'.repeat(64),
  originalFilename: 'khatian-104.pdf',
})

/** A PNG, which both readers accept. */
const IMAGE_REQUEST = requestWith({
  mediaType: 'image/png',
  bytes: PNG_BYTES,
  byteSize: PNG_BYTES.byteLength,
  sha256: 'c'.repeat(64),
  originalFilename: 'khatian-104.png',
})

/** A record with no stored file: nothing to read. */
const METADATA_ONLY_REQUEST = requestWith(null)

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

  it('declares that it reads document content and what it supports', () => {
    const provider = new GeminiExtractionProvider(geminiOptions)

    expect(provider.readsDocumentContent).toBe(true)
    expect(provider.supportedMediaTypes).toEqual([
      'application/pdf',
      'image/png',
      'image/jpeg',
    ])
  })

  it('refuses to run when unconfigured rather than returning empty readings', async () => {
    const provider = new GeminiExtractionProvider({ ...geminiOptions, apiKey: '' })

    await expect(provider.extract(PDF_REQUEST)).rejects.toBeInstanceOf(ExtractionProviderError)
  })

  it('sends the document itself as inline data, with its media type', async () => {
    const calls: CapturedCall[] = []
    const provider = new GeminiExtractionProvider({
      ...geminiOptions,
      fetchImpl: transport(
        () => ({ status: 200, body: geminiEnvelope({ fields: [] }) }),
        calls,
      ),
    })

    await provider.extract(PDF_REQUEST)

    const body = JSON.parse(calls[0]?.body ?? '{}') as {
      contents: { parts: ({ text?: string } & Record<string, unknown>)[] }[]
    }
    const parts = body.contents[0]?.parts ?? []
    const inline = parts.find((part) => 'inlineData' in part)?.inlineData as
      | { mimeType: string; data: string }
      | undefined

    // The document's own bytes are in the request — not merely its title.
    expect(inline?.mimeType).toBe('application/pdf')
    expect(inline?.data).toBe(PDF_BYTES.toString('base64'))
    expect(Buffer.from(inline?.data ?? '', 'base64').equals(PDF_BYTES)).toBe(true)
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

    await provider.extract(PDF_REQUEST)

    const call = calls[0]
    expect(call?.method).toBe('POST')
    expect(call?.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-test-model:generateContent',
    )
    expect(call?.headers['x-goog-api-key']).toBe('gemini-test-key')
    expect(call?.body).toContain('khatian, area')
    expect(call?.body).toContain('RS khatian 104')
    // The instruction tells the reader the document is attached, and that the
    // metadata is not the document.
    expect(call?.body).toContain('attached')
  })

  it('refuses a record with no stored document instead of reading its metadata', async () => {
    const calls: CapturedCall[] = []
    const provider = new GeminiExtractionProvider({
      ...geminiOptions,
      fetchImpl: transport(
        () => ({ status: 200, body: geminiEnvelope({ fields: [] }) }),
        calls,
      ),
    })

    const error = await provider.extract(METADATA_ONLY_REQUEST).catch((thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(ExtractionProviderError)
    expect((error as ExtractionProviderError).retryable).toBe(false)
    expect((error as ExtractionProviderError).message).toContain('no stored file')
    // Nothing was sent: a request that cannot be served is never attempted.
    expect(calls).toHaveLength(0)
  })

  it('refuses a media type it does not support, sending nothing', async () => {
    const calls: CapturedCall[] = []
    const provider = new GeminiExtractionProvider({
      ...geminiOptions,
      fetchImpl: transport(
        () => ({ status: 200, body: geminiEnvelope({ fields: [] }) }),
        calls,
      ),
    })

    const textRequest = requestWith({
      mediaType: 'text/plain',
      bytes: Buffer.from('not a scan'),
      byteSize: 11,
      sha256: 'd'.repeat(64),
      originalFilename: 'notes.txt',
    })

    await expect(provider.extract(textRequest)).rejects.toThrow(/cannot read text\/plain/)
    expect(calls).toHaveLength(0)
  })

  it('refuses a document larger than the inline request limit', async () => {
    const calls: CapturedCall[] = []
    const provider = new GeminiExtractionProvider({
      ...geminiOptions,
      maxContentBytes: 8,
      fetchImpl: transport(
        () => ({ status: 200, body: geminiEnvelope({ fields: [] }) }),
        calls,
      ),
    })

    await expect(provider.extract(PDF_REQUEST)).rejects.toThrow(/larger than the 8 byte limit/)
    expect(calls).toHaveLength(0)
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

    const result = await provider.extract(PDF_REQUEST)
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

    const result = await provider.extract(PDF_REQUEST)
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

    const result = await provider.extract(PDF_REQUEST)
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

    const result = await provider.extract(PDF_REQUEST)

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

    const error = await provider.extract(PDF_REQUEST).catch((thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(ExtractionProviderError)
    expect((error as ExtractionProviderError).retryable).toBe(true)
    expect((error as ExtractionProviderError).message).toContain('429')
    // Neither the document we sent nor the body we received is echoed back.
    expect((error as ExtractionProviderError).message).not.toContain('document text')
    expect((error as ExtractionProviderError).message).not.toContain(
      PDF_BYTES.toString('base64'),
    )
  })

  it('fails when the provider body is not JSON', async () => {
    const provider = new GeminiExtractionProvider({
      ...geminiOptions,
      fetchImpl: transport(() => ({ status: 200, body: '<html>gateway</html>' })),
    })

    await expect(provider.extract(PDF_REQUEST)).rejects.toThrow(/not JSON/)
  })

  it('fails when the response has no text part', async () => {
    const provider = new GeminiExtractionProvider({
      ...geminiOptions,
      fetchImpl: transport(() => ({
        status: 200,
        body: JSON.stringify({ candidates: [{ content: { parts: [] } }] }),
      })),
    })

    await expect(provider.extract(PDF_REQUEST)).rejects.toThrow(/no text part/)
  })

  it('fails when the model payload does not match the expected schema', async () => {
    const provider = new GeminiExtractionProvider({
      ...geminiOptions,
      fetchImpl: transport(() => ({
        status: 200,
        body: geminiEnvelope({ fields: [{ field: 'area', confidence: 4 }] }),
      })),
    })

    await expect(provider.extract(PDF_REQUEST)).rejects.toThrow(/schema/)
  })

  it('reports a timeout as retryable rather than as an empty read', async () => {
    const aborting: FetchImplementation = async (_url, init) => {
      const error = new Error('aborted')
      error.name = 'AbortError'
      void init.signal
      throw error
    }
    const provider = new GeminiExtractionProvider({ ...geminiOptions, fetchImpl: aborting })

    const error = await provider.extract(PDF_REQUEST).catch((thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(ExtractionProviderError)
    expect((error as ExtractionProviderError).retryable).toBe(true)
    expect((error as ExtractionProviderError).message).toContain('did not respond')
  })
})

describe('GroqExtractionProvider', () => {
  it('declares the image types it can read and that it reads content', () => {
    const provider = new GroqExtractionProvider(groqOptions)

    expect(provider.readsDocumentContent).toBe(true)
    // No PDF: Groq's vision endpoint takes images, and pretending otherwise
    // would send a PDF to be answered from the prompt alone.
    expect(provider.supportedMediaTypes).toEqual(['image/png', 'image/jpeg'])
  })

  it('sends the image as a base64 data URL with its media type', async () => {
    const calls: CapturedCall[] = []
    const provider = new GroqExtractionProvider({
      ...groqOptions,
      fetchImpl: transport(
        () => ({ status: 200, body: groqEnvelope({ fields: [] }) }),
        calls,
      ),
    })

    await provider.extract(IMAGE_REQUEST)

    const body = JSON.parse(calls[0]?.body ?? '{}') as {
      messages: { content: ({ type: string } & Record<string, unknown>)[] }[]
    }
    const image = body.messages[0]?.content.find((part) => part.type === 'image_url')
    const url = (image?.image_url as { url?: string } | undefined)?.url

    expect(url).toBe(`data:image/png;base64,${PNG_BYTES.toString('base64')}`)
    expect(Buffer.from((url ?? '').split(',')[1] ?? '', 'base64').equals(PNG_BYTES)).toBe(true)
  })

  it('refuses a PDF, because it has no document input', async () => {
    const calls: CapturedCall[] = []
    const provider = new GroqExtractionProvider({
      ...groqOptions,
      fetchImpl: transport(
        () => ({ status: 200, body: groqEnvelope({ fields: [] }) }),
        calls,
      ),
    })

    const error = await provider.extract(PDF_REQUEST).catch((thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(ExtractionProviderError)
    expect((error as ExtractionProviderError).retryable).toBe(false)
    expect((error as ExtractionProviderError).message).toContain('cannot read application/pdf')
    expect(calls).toHaveLength(0)
  })

  it('refuses a record with no stored document', async () => {
    const provider = new GroqExtractionProvider({
      ...groqOptions,
      fetchImpl: transport(() => ({ status: 200, body: groqEnvelope({ fields: [] }) })),
    })

    await expect(provider.extract(METADATA_ONLY_REQUEST)).rejects.toThrow(/no stored file/)
  })

  it('posts an OpenAI-compatible chat completion with a bearer token', async () => {
    const calls: CapturedCall[] = []
    const provider = new GroqExtractionProvider({
      ...groqOptions,
      fetchImpl: transport(
        () => ({ status: 200, body: groqEnvelope({ fields: [{ field: 'khatian', value: '104' }] }) }),
        calls,
      ),
    })

    const result = await provider.extract(IMAGE_REQUEST)

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

    await expect(provider.extract(IMAGE_REQUEST)).rejects.toThrow(/no message content/)
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

    const result = await new FallbackExtractionProvider([gemini, groq]).extract(IMAGE_REQUEST)

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

    const result = await new FallbackExtractionProvider([gemini, groq]).extract(IMAGE_REQUEST)

    expect(result.provider).toBe('groq')
    expect(result.fields.find((field) => field.field === 'khatian')?.value).toBe('from-groq')
  })

  it('never sends a document to a provider that cannot read its media type', async () => {
    const geminiCalls: CapturedCall[] = []
    const groqCalls: CapturedCall[] = []
    const gemini = new GeminiExtractionProvider({
      ...geminiOptions,
      fetchImpl: transport(() => ({ status: 500, body: 'upstream error' }), geminiCalls),
    })
    const groq = new GroqExtractionProvider({
      ...groqOptions,
      fetchImpl: transport(() => ({ status: 200, body: groqEnvelope({ fields: [] }) }), groqCalls),
    })

    // A PDF: only Gemini can read it, and Gemini fails. Groq is skipped rather
    // than sent a PDF it would answer from the prompt.
    await expect(
      new FallbackExtractionProvider([gemini, groq]).extract(PDF_REQUEST),
    ).rejects.toThrow(/Every compatible provider failed/)
    expect(geminiCalls).toHaveLength(1)
    expect(groqCalls).toHaveLength(0)
  })

  it('names the media type when no configured provider can read it', async () => {
    // Only Groq is configured, and the document is a PDF it cannot read.
    const provider = new FallbackExtractionProvider([
      new GeminiExtractionProvider({ ...geminiOptions, apiKey: '' }),
      new GroqExtractionProvider({
        ...groqOptions,
        fetchImpl: transport(() => ({ status: 200, body: groqEnvelope({ fields: [] }) })),
      }),
    ])

    await expect(provider.extract(PDF_REQUEST)).rejects.toThrow(
      /No configured provider can read application\/pdf/,
    )
  })

  it('refuses a metadata-only record when a reader is required', async () => {
    const gemini = new GeminiExtractionProvider({
      ...geminiOptions,
      fetchImpl: transport(() => ({ status: 200, body: geminiEnvelope({ fields: [] }) })),
    })

    const provider = new FallbackExtractionProvider([gemini])
    expect(provider.readsDocumentContent).toBe(true)
    await expect(provider.extract(METADATA_ONLY_REQUEST)).rejects.toThrow(
      /no stored file/,
    )
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
    const error = await provider.extract(IMAGE_REQUEST).catch((thrown: unknown) => thrown)

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
    await expect(provider.extract(IMAGE_REQUEST)).rejects.toThrow(
      /No external extraction provider/,
    )
  })
})
