import { describe, expect, it } from 'vitest'

import {
  DEMO_DOCUMENT_FIXTURES,
  MockExtractionProvider,
} from '../../src/extraction/mock-provider.js'
import {
  ExtractionProviderError,
  type ExtractionRequest,
} from '../../src/extraction/provider.js'

/**
 * The deterministic mock provider.
 *
 * This is a test double, not a reader. These tests exist to pin down what it
 * *refuses* to do: it must never invent a confidence, a bounding box, or a value
 * for a document it has no fixture for. A mock that fabricated plausible output
 * would make the review workflow look healthy while proving nothing.
 */

const UNKNOWN_DOCUMENT = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
const DEMO_DOCUMENT = 'b1000000-0000-4000-8000-000000000001'

function request(sourceDocumentId: string, fields: ExtractionRequest['fields'] = ['khatian']): ExtractionRequest {
  return {
    sourceDocumentId,
    title: 'A document',
    reference: null,
    pageCount: 1,
    fields,
    content: null,
  }
}

describe('MockExtractionProvider', () => {
  it('is usable with no credentials', () => {
    const provider = new MockExtractionProvider()

    expect(provider.name).toBe('mock')
    expect(provider.requiresCredentials).toBe(false)
    expect(provider.isConfigured()).toBe(true)
  })

  it('declares that it does not read document content', () => {
    const provider = new MockExtractionProvider()

    // This is what distinguishes a synthetic double from a reader: it is what
    // lets the worker skip loading a file, and what the job result reports so a
    // reader of the result never mistakes fixture output for a real read.
    expect(provider.readsDocumentContent).toBe(false)
    expect(provider.supportedMediaTypes).toBeNull()
  })

  it('ignores any content it is handed, because it reads no content', async () => {
    const provider = new MockExtractionProvider({ fixtures: DEMO_DOCUMENT_FIXTURES })

    const withContent = await provider.extract({
      ...request(DEMO_DOCUMENT, ['khatian']),
      content: {
        mediaType: 'application/pdf',
        bytes: new Uint8Array([1, 2, 3, 4]),
        byteSize: 4,
        sha256: 'a'.repeat(64),
        originalFilename: 'record.pdf',
      },
    })

    // Identical to the fixture result: the bytes had no effect, because nothing
    // in this provider looks at them.
    expect(withContent.fields.find((field) => field.field === 'khatian')).toMatchObject({
      value: '104',
      isUnclear: false,
    })
  })

  it('reports every field as unclear for a document it has no fixture for', async () => {
    const provider = new MockExtractionProvider()
    const result = await provider.extract(request(UNKNOWN_DOCUMENT, ['khatian', 'area', 'share']))

    expect(result.fields).toHaveLength(3)
    for (const field of result.fields) {
      expect(field.isUnclear).toBe(true)
      // An empty value, not a plausible one. Nothing was read.
      expect(field.value).toBe('')
      expect(field.confidence).toBeNull()
      expect(field.boundingBox).toBeNull()
    }
    expect(result.warnings.join(' ')).toContain('no fixture')
  })

  it('never reports a confidence or a bounding box, even for a fixture it knows', async () => {
    const provider = new MockExtractionProvider({ fixtures: DEMO_DOCUMENT_FIXTURES })
    const result = await provider.extract(request(DEMO_DOCUMENT, ['khatian', 'area', 'share']))

    for (const field of result.fields) {
      // The provider measured nothing, so it claims nothing.
      expect(field.confidence).toBeNull()
      expect(field.boundingBox).toBeNull()
    }

    const khatian = result.fields.find((field) => field.field === 'khatian')
    expect(khatian).toMatchObject({
      value: '104',
      isUnclear: false,
      pageNumber: 1,
    })
  })

  it('carries the demo fixture’s deliberately unreadable share entry through', async () => {
    const provider = new MockExtractionProvider({ fixtures: DEMO_DOCUMENT_FIXTURES })
    const result = await provider.extract(request(DEMO_DOCUMENT, ['share']))

    const share = result.fields[0]
    expect(share?.isUnclear).toBe(true)
    expect(share?.confidence).toBeNull()
  })

  it('produces identical output for identical input', async () => {
    const provider = new MockExtractionProvider({ fixtures: DEMO_DOCUMENT_FIXTURES })

    const first = await provider.extract(request(DEMO_DOCUMENT, ['khatian', 'area']))
    const second = await provider.extract(request(DEMO_DOCUMENT, ['khatian', 'area']))

    expect(second.fields).toEqual(first.fields)
    expect(second.provider).toBe(first.provider)
  })

  it('cannot be handed a fixture per request, so a caller cannot inject its own result', async () => {
    // The fixture set is fixed at construction. Asking about a different
    // document yields unclear readings even though a fixture exists for another.
    const provider = new MockExtractionProvider({ fixtures: DEMO_DOCUMENT_FIXTURES })
    const result = await provider.extract(request(UNKNOWN_DOCUMENT, ['khatian']))

    expect(result.fields[0]?.isUnclear).toBe(true)
  })

  it('defaults to no fixtures, so nothing is fabricated out of the box', async () => {
    const provider = new MockExtractionProvider()
    const result = await provider.extract(request(DEMO_DOCUMENT, ['khatian']))

    expect(result.fields[0]?.isUnclear).toBe(true)
    expect(result.warnings.length).toBeGreaterThan(0)
  })

  it('fails every call in `always` failure mode', async () => {
    const provider = new MockExtractionProvider({ failureMode: 'always' })

    const error = await provider.extract(request(DEMO_DOCUMENT)).catch((thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(ExtractionProviderError)
    expect((error as ExtractionProviderError).retryable).toBe(true)
  })

  it('fails the configured number of attempts and then succeeds', async () => {
    const provider = new MockExtractionProvider({
      fixtures: DEMO_DOCUMENT_FIXTURES,
      failureMode: 'transient',
      failFirst: 2,
    })

    await expect(provider.extract(request(DEMO_DOCUMENT))).rejects.toBeInstanceOf(
      ExtractionProviderError,
    )
    await expect(provider.extract(request(DEMO_DOCUMENT))).rejects.toBeInstanceOf(
      ExtractionProviderError,
    )

    const third = await provider.extract(request(DEMO_DOCUMENT, ['khatian']))
    expect(third.fields[0]?.value).toBe('104')
    expect(provider.calls).toBe(3)
  })

  it('counts its calls, so a test can prove a job was not executed twice', async () => {
    const provider = new MockExtractionProvider()

    expect(provider.calls).toBe(0)
    await provider.extract(request(DEMO_DOCUMENT))
    await provider.extract(request(DEMO_DOCUMENT))
    expect(provider.calls).toBe(2)
  })
})
