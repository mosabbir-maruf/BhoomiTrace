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
 * 4. **A reading comes from the document.** A provider that reads content is
 *    handed the stored bytes and refuses a request without them. Metadata — a
 *    title, a reference, a page count — is never enough to produce a value, so
 *    there is no path from "we hold no copy of this document" to "here is what
 *    it says".
 */

/** What a provider is asked to read. */
export interface ExtractionRequest {
  sourceDocumentId: string
  title: string
  reference: string | null
  pageCount: number | null
  /** Fields to look for. A provider returns exactly these, or marks them unclear. */
  fields: readonly ExtractionField[]
  /**
   * The stored document itself, when one exists.
   *
   * `null` means the record is metadata only — it describes a document the
   * platform does not hold a copy of. A provider that reads document content
   * must refuse such a request rather than answering from the metadata: a
   * plausible value invented from a title is an unsupported record, not a
   * reading. Only a provider that declares `readsDocumentContent === false` may
   * run without content, and that declaration is what marks it as synthetic.
   *
   * The bytes are loaded from private storage by the worker and are never placed
   * in a job payload, a log line, or an audit row.
   */
  content: ExtractionSourceContent | null
}

/** The stored bytes of a document, and the facts needed to send them. */
export interface ExtractionSourceContent {
  /** Sniffed media type, e.g. `application/pdf`. Never the client's claim. */
  mediaType: string
  bytes: Uint8Array
  byteSize: number
  /** SHA-256 of the stored file, verified against the record when loaded. */
  sha256: string
  /** The name the uploader gave it, for the provider's benefit only. */
  originalFilename: string | null
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
  /**
   * Whether this provider actually reads the document.
   *
   * `true` for a real reader: its readings come from the bytes it was given, so
   * it refuses a request with no content and never answers from metadata. `false`
   * for a synthetic double, whose readings are fixtures and whose output must be
   * presented as such. Nothing downstream treats the two the same: the
   * distinction is recorded on the job result and in the startup log.
   */
  readonly readsDocumentContent: boolean
  /**
   * Media types the provider can read, or `null` when it does not read content.
   *
   * A provider that reads content lists exactly what it supports; a request for
   * anything else is refused rather than sent, so a PDF is never posted to an
   * image-only model that would answer from the prompt text alone.
   */
  readonly supportedMediaTypes: readonly string[] | null
  /** True when this provider can be used with the current configuration. */
  isConfigured(): boolean
  extract(request: ExtractionRequest): Promise<ExtractionResult>
}

/**
 * Checks that a provider is able to read a request, before it is called.
 *
 * Shared by the adapters and by the worker so both agree on one rule: a provider
 * that reads content must be given content of a type it supports, and a
 * metadata-only request is never answered from metadata.
 *
 * @throws {ExtractionProviderError} when the provider cannot read the request.
 */
export function assertProviderCanRead(
  provider: Pick<ExtractionProvider, 'name' | 'readsDocumentContent' | 'supportedMediaTypes'>,
  request: ExtractionRequest,
): void {
  if (!provider.readsDocumentContent) return

  if (request.content === null) {
    throw new ExtractionProviderError(
      provider.name,
      'The document has no stored file, so there is nothing for this provider to read.',
      false,
    )
  }

  const supported = provider.supportedMediaTypes
  if (supported !== null && !supported.includes(request.content.mediaType)) {
    throw new ExtractionProviderError(
      provider.name,
      `This provider cannot read ${request.content.mediaType}. It supports ${supported.join(', ')}.`,
      false,
    )
  }
}

/** True when the provider would accept the request, used for routing. */
export function providerCanRead(
  provider: Pick<ExtractionProvider, 'readsDocumentContent' | 'supportedMediaTypes'>,
  request: ExtractionRequest,
): boolean {
  if (!provider.readsDocumentContent) return true
  if (request.content === null) return false
  const supported = provider.supportedMediaTypes
  return supported === null || supported.includes(request.content.mediaType)
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
