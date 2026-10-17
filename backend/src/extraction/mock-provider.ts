import type { ExtractionField } from '../db/schema/enums.js'
import {
  ExtractionProviderError,
  type ExtractedField,
  type ExtractionProvider,
  type ExtractionRequest,
  type ExtractionResult,
} from './provider.js'

/**
 * The deterministic mock extraction provider.
 *
 * This is a **plumbing test double, not an OCR engine.** It is the default
 * development and test provider precisely so that the whole pipeline — queue,
 * worker, persistence, review — can be exercised with no credentials and no
 * network access.
 *
 * What it deliberately does *not* do:
 *
 * - It does not read pixels. It has no fixtures for arbitrary documents, so a
 *   document it does not know about yields every requested field marked
 *   `isUnclear`. Reporting "unreadable" is the honest answer from a reader that
 *   cannot read; filling in a plausible value would be an invented record.
 * - It never reports a confidence. It measured nothing, so it says so with
 *   `null`. A fabricated `0.94` would be indistinguishable from a real model's
 *   output and would be trusted accordingly.
 * - It never reports a bounding box, for the same reason.
 *
 * Fixtures are supplied at construction time, never per request, so a caller
 * cannot inject the extraction result of its own document.
 */

/** One field as the fixture knows it. */
export interface MockFieldFixture {
  value: string
  /** Marked unclear when the fixture models a badly legible entry. */
  isUnclear?: boolean
  pageNumber?: number | null
  pageReference?: string | null
}

export type MockDocumentFixture = Partial<
  Record<ExtractionField, MockFieldFixture>
>

export interface MockProviderOptions {
  /**
   * Fixtures keyed by source-document id. A document with no fixture yields
   * unclear results for every requested field.
   */
  fixtures?: Readonly<Record<string, MockDocumentFixture>>
  /** Model label recorded on extraction rows. Defaults to `mock-v1`. */
  model?: string
  /** Artificial delay, used to test leases and concurrent claims. */
  delayMs?: number
  /** Set to make every call fail, for retry and exhaustion tests. */
  failureMode?: 'none' | 'always' | 'transient'
  /** Number of calls to fail before succeeding in `transient` mode. */
  failFirst?: number
}

export class MockExtractionProvider implements ExtractionProvider {
  readonly name = 'mock'
  readonly model: string
  readonly requiresCredentials = false

  private readonly fixtures: Readonly<Record<string, MockDocumentFixture>>
  private readonly delayMs: number
  private readonly failureMode: 'none' | 'always' | 'transient'
  private readonly failFirst: number
  private callCount = 0

  constructor(options: MockProviderOptions = {}) {
    this.fixtures = options.fixtures ?? {}
    this.model = options.model ?? 'mock-v1'
    this.delayMs = options.delayMs ?? 0
    this.failureMode = options.failureMode ?? 'none'
    this.failFirst = options.failFirst ?? 1
  }

  isConfigured(): boolean {
    return true
  }

  /** How many times `extract` has been called. Used by tests. */
  get calls(): number {
    return this.callCount
  }

  async extract(request: ExtractionRequest): Promise<ExtractionResult> {
    this.callCount += 1

    if (this.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs))
    }

    if (this.failureMode === 'always') {
      throw new ExtractionProviderError(
        this.name,
        'The mock provider is configured to fail every extraction.',
        true,
      )
    }

    if (this.failureMode === 'transient' && this.callCount <= this.failFirst) {
      throw new ExtractionProviderError(
        this.name,
        `Mock provider transient failure on attempt ${this.callCount}.`,
        true,
      )
    }

    const fixture = this.fixtures[request.sourceDocumentId] ?? {}

    const fields: ExtractedField[] = request.fields.map((field) => {
      const known = fixture[field]

      if (known === undefined || known.isUnclear === true) {
        return {
          field,
          // The field is reported as unclear with no value claimed. The raw
          // value is an empty string rather than a guess.
          value: known?.value ?? '',
          confidence: null,
          isUnclear: true,
          pageNumber: known?.pageNumber ?? null,
          pageReference: known?.pageReference ?? null,
          boundingBox: null,
        }
      }

      return {
        field,
        value: known.value,
        // No confidence is reported: this provider measured none.
        confidence: null,
        isUnclear: false,
        pageNumber: known.pageNumber ?? null,
        pageReference: known.pageReference ?? null,
        // No bounding box is reported: this provider located nothing.
        boundingBox: null,
      }
    })

    return {
      provider: this.name,
      model: this.model,
      extractedAt: new Date(),
      fields,
      warnings:
        Object.keys(fixture).length === 0
          ? [
              'The mock provider has no fixture for this document, so every field is reported as unclear.',
            ]
          : [],
    }
  }
}

/**
 * Built-in fixtures for the seeded demo document.
 *
 * These describe the synthetic demo record that Phase 1 seeds, so the demo flow
 * produces a real, reviewable extraction without any credentials. The values
 * match the seed exactly, including the deliberately unreadable share entry that
 * gives the review workflow something to resolve.
 */
export const DEMO_DOCUMENT_FIXTURES: Readonly<Record<string, MockDocumentFixture>> = {
  'b1000000-0000-4000-8000-000000000001': {
    khatian: { value: '104', pageNumber: 1, pageReference: 'শিরোনাম, ঘর ১' },
    mouza: { value: 'শালবন', pageNumber: 1, pageReference: 'শিরোনাম, ঘর ২' },
    dag: { value: '341', pageNumber: 1, pageReference: 'তফসিল, ঘর ১' },
    area: { value: '125.0000', pageNumber: 1, pageReference: 'তফসিল, ঘর ৩' },
    // A share column that the demo record shows as smudged: the fixture models
    // that by marking it unclear, so a reviewer has to decide.
    share: { value: '১/২ (অস্পষ্ট)', isUnclear: true, pageNumber: 1 },
  },
}
