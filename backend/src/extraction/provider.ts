import type { ExtractionField } from '../db/schema/enums.js'
import type { BoundingBox } from '../db/schema/types.js'

/**
 * The provider-independent extraction contract.
 *
 * Everything above this interface — the queue, the worker, the persistence, the
 * review workflow — is written against these types, so adding a real reader is a
 * matter of writing one object that satisfies `ExtractionProvider`. Nothing
 * else changes.
 *
 * Three invariants hold for every provider, and each has a test:
 *
 * 1. **A failure is never a success.** If a provider cannot read a document it
 *    either reports the fields as unclear or throws. It never returns plausible
 *    filler, and a configured-but-failing provider never degrades into a
 *    successful empty result.
 * 2. **Confidence is optional and never fabricated.** `confidence` is `null`
 *    unless the provider actually measured one. Zero and "no measurement" are
 *    different facts and are stored differently.
 * 3. **Provenance is reported, not guessed.** A page number or bounding box is
 *    present only when the provider supplied it. A provider that did not
 *    measure a region returns `null`, and nothing downstream invents one.
 */

/** What a provider is asked to read. Contains no document contents. */
export interface ExtractionRequest {
  sourceDocumentId: string
  title: string
  reference: string | null
  pageCount: number | null
  /** Fields to look for. A provider returns exactly these, or marks them unclear. */
  fields: readonly ExtractionField[]
}

export interface ExtractedField {
  field: ExtractionField
  /** Exactly what was read. Never a corrected or normalised value. */
  value: string
  /** `null` when the provider did not report one. Never invented. */
  confidence: number | null
  /** True when the provider could not read the field with confidence. */
  isUnclear: boolean
  /** 1-based page, or `null` when the provider did not identify one. */
  pageNumber: number | null
  /** Human-readable location, e.g. "তফসিল, ঘর ৩". */
  pageReference: string | null
  /** Normalised region, or `null` when the provider did not report one. */
  boundingBox: BoundingBox | null
}

export interface ExtractionResult {
  /** Provider name, recorded on every extraction row. */
  provider: string
  /** Model identifier, when the provider names one. */
  model: string | null
  /** When the provider produced the read. */
  extractedAt: Date
  fields: ExtractedField[]
  /** Non-sensitive provider remarks, e.g. "page 2 was unreadable". */
  warnings: string[]
}

export interface ExtractionProvider {
  /** Stable identifier stored on extraction rows and audit events. */
  readonly name: string
  readonly model: string | null
  /** True when the provider cannot work without credentials. */
  readonly requiresCredentials: boolean
  /** True when this provider can be used with the current configuration. */
  isConfigured(): boolean
  extract(request: ExtractionRequest): Promise<ExtractionResult>
}

/** Raised when a provider is asked to do work it is not configured for. */
export class ExtractionProviderError extends Error {
  override readonly name = 'ExtractionProviderError'

  constructor(
    readonly provider: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message)
  }
}

/** All fields the platform knows how to extract, in a stable order. */
export const ALL_EXTRACTION_FIELDS: readonly ExtractionField[] = [
  'khatian',
  'mouza',
  'dag',
  'area',
  'share',
  'owner',
]
