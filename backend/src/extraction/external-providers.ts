import { z } from 'zod'

import type { ExtractionField } from '../db/schema/enums.js'
import type { BoundingBox } from '../db/schema/types.js'
import {
  assertProviderCanRead,
  providerCanRead,
  ExtractionProviderError,
  type ExtractedField,
  type ExtractionProvider,
  type ExtractionRequest,
  type ExtractionResult,
} from './provider.js'

/**
 * HTTP adapters for the intended Gemini-primary / Groq-fallback readers.
 *
 * ## What is and is not verified here
 *
 * The request/response mapping, timeout handling, JSON validation, failure
 * behaviour, and the *content* of the outbound request are covered by tests
 * against an injected transport. Those tests decode the body and assert the
 * document's own bytes and media type appear in it. **No live call has been
 * made**, and none can be made without credentials the project does not hold;
 * whether a given account's model accepts a given file is therefore unverified.
 * The endpoint paths and request shapes follow each vendor's documented REST
 * format, and the model identifiers live in configuration rather than in code,
 * because a model name is a moving target — an operator confirms it in the
 * provider's console before enabling the adapter.
 *
 * ## Content, not metadata
 *
 * A reader is given the stored document and told to read it. It is never given
 * only a title and asked to guess: that would turn "we hold a record of a
 * document" into "here is what the document says", which is not a reading at
 * all. A request with no stored content, or with a media type the adapter does
 * not support, is refused before any bytes are sent.
 *
 * ## Failure semantics
 *
 * A non-2xx response, a timeout, unparseable output, or output that fails
 * validation all raise `ExtractionProviderError`. There is no path in which a
 * failed call is recorded as a successful extraction, because a silent empty
 * success is far more dangerous than a visible failure: it would look like the
 * document simply contained nothing.
 */

const boundingBoxSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  width: z.number().min(0).max(1),
  height: z.number().min(0).max(1),
})

/**
 * The response shape requested from the model.
 *
 * Every optional field is `.nullable()` rather than `.optional()`, because the
 * prompt asks the model to state `null` explicitly. A missing key and an
 * explicit `null` are then the same thing, and neither is treated as a value.
 */
const modelResponseSchema = z.object({
  fields: z
    .array(
      z.object({
        field: z.string(),
        value: z.string().nullable().optional(),
        confidence: z.number().min(0).max(1).nullable().optional(),
        unclear: z.boolean().nullable().optional(),
        pageNumber: z.number().int().min(1).nullable().optional(),
        pageReference: z.string().nullable().optional(),
        boundingBox: boundingBoxSchema.nullable().optional(),
      }),
    )
    .max(64),
})

export type FetchImplementation = (
  input: string,
  init: {
    method: string
    headers: Record<string, string>
    body: string
    signal: AbortSignal
  },
) => Promise<{
  ok: boolean
  status: number
  text(): Promise<string>
}>

export interface ExternalProviderOptions {
  apiKey: string
  model: string
  timeoutMs: number
  /**
   * Largest document that may be sent inline to this provider.
   *
   * Both vendors cap an inline request at about 20 MB; the default is that
   * documented ceiling, and the worker's own file loader caps the file before
   * this even runs. The check exists so a larger upload limit could never turn
   * into a silently truncated request.
   */
  maxContentBytes?: number
  /** Injectable transport so tests never touch the network. */
  fetchImpl?: FetchImplementation
  baseUrl?: string
}

/** Both vendors document a roughly 20 MB inline request ceiling. */
const DEFAULT_MAX_CONTENT_BYTES = 20 * 1024 * 1024

/** Encodes bytes as base64 without ever building a string of raw content. */
function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64')
}

/** Builds the instruction sent to an external reader. */
function buildPrompt(request: ExtractionRequest): string {
  const attachment =
    request.content === null
      ? 'No document is attached.'
      : `The document is attached (${request.content.mediaType}${
          request.content.originalFilename === null
            ? ''
            : `, filename: ${request.content.originalFilename}`
        }). Read the attached document.`

  return [
    'You are reading a land record for a records-verification system.',
    attachment,
    'Return only JSON of the form:',
    '{"fields":[{"field":"khatian","value":"...","confidence":0.0,"unclear":false,',
    '"pageNumber":1,"pageReference":"...","boundingBox":null}]}',
    '',
    'Rules you must follow:',
    '- Return exactly these fields: ' + request.fields.join(', ') + '.',
    '- Read the values from the attached document. Never infer a value from the',
    '  metadata below; it identifies the record, it is not its contents.',
    '- Omit rather than guess. If you cannot read a field, set "unclear" to true',
    '  and set "value" to null.',
    '- Set "confidence" to null when you have no calibrated confidence. Do not',
    '  invent a number.',
    '- Set "boundingBox" to null unless you can give a normalised x, y, width,',
    '  height (0-1) for the region you read.',
    '- Do not infer ownership, legal continuity, or approval of any kind.',
    '',
    `Document title: ${request.title}`,
    `Document reference: ${request.reference ?? 'not recorded'}`,
    `Recorded page count: ${request.pageCount ?? 'not recorded'}`,
  ].join('\n')
}

/** Maps a validated model payload onto `ExtractedField`s. */
function mapResponse(
  raw: string,
  requestedFields: readonly ExtractionField[],
  providerName: string,
): { fields: ExtractedField[]; warnings: string[] } {
  let parsedJson: unknown
  try {
    parsedJson = JSON.parse(raw) as unknown
  } catch {
    throw new ExtractionProviderError(
      providerName,
      'The provider did not return JSON.',
      true,
    )
  }

  const validated = modelResponseSchema.safeParse(parsedJson)
  if (!validated.success) {
    throw new ExtractionProviderError(
      providerName,
      'The provider response did not match the expected schema.',
      true,
    )
  }

  const warnings: string[] = []
  const byField = new Map<string, ExtractedField>()

  for (const entry of validated.data.fields) {
    if (!requestedFields.includes(entry.field as ExtractionField)) {
      // A field we did not ask about is discarded rather than stored, and the
      // discard is reported so it is visible rather than silent.
      warnings.push(`Ignored a field that was not requested: ${entry.field}.`)
      continue
    }

    const field = entry.field as ExtractionField
    const value = entry.value ?? ''
    const isUnclear = entry.unclear === true || value.length === 0

    const boundingBox: BoundingBox | null =
      entry.boundingBox === null || entry.boundingBox === undefined
        ? null
        : {
            x: entry.boundingBox.x,
            y: entry.boundingBox.y,
            width: entry.boundingBox.width,
            height: entry.boundingBox.height,
          }

    byField.set(field, {
      field,
      value,
      // `null` stays `null`: an absent confidence is not promoted to a number.
      confidence: entry.confidence ?? null,
      isUnclear,
      pageNumber: entry.pageNumber ?? null,
      pageReference: entry.pageReference ?? null,
      boundingBox,
    })
  }

  const fields = requestedFields.map((field) => {
    const found = byField.get(field)
    if (found !== undefined) return found
    // A field the provider did not mention is reported as unread, not empty.
    return {
      field,
      value: '',
      confidence: null,
      isUnclear: true,
      pageNumber: null,
      pageReference: null,
      boundingBox: null,
    } satisfies ExtractedField
  })

  return { fields, warnings }
}

/** Shared transport: timeout, error mapping, and safe error text. */
async function postForJson(
  options: ExternalProviderOptions,
  providerName: string,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  extractText: (payload: unknown) => string,
): Promise<{ text: string; model: string }> {
  const fetchImpl =
    options.fetchImpl ?? (globalThis.fetch as unknown as FetchImplementation)

  if (fetchImpl === undefined) {
    throw new ExtractionProviderError(
      providerName,
      'No fetch implementation is available in this runtime.',
      false,
    )
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs)

  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    })

    const text = await response.text()

    if (!response.ok) {
      // The provider's own error body may quote document contents, so it is
      // never propagated: only the status code is reported.
      throw new ExtractionProviderError(
        providerName,
        `The provider responded with status ${response.status}.`,
        response.status >= 500 || response.status === 429,
      )
    }

    let payload: unknown
    try {
      payload = JSON.parse(text) as unknown
    } catch {
      throw new ExtractionProviderError(
        providerName,
        'The provider responded with a body that is not JSON.',
        true,
      )
    }

    return { text: extractText(payload), model: options.model }
  } catch (error) {
    if (error instanceof ExtractionProviderError) throw error
    if (error instanceof Error && error.name === 'AbortError') {
      throw new ExtractionProviderError(
        providerName,
        `The provider did not respond within ${options.timeoutMs}ms.`,
        true,
      )
    }
    throw new ExtractionProviderError(
      providerName,
      'The provider request failed before a response was received.',
      true,
    )
  } finally {
    clearTimeout(timer)
  }
}

/** Refuses a document too large to send inline to this provider. */
function assertWithinSizeLimit(
  providerName: string,
  options: ExternalProviderOptions,
  byteSize: number,
): void {
  const limit = options.maxContentBytes ?? DEFAULT_MAX_CONTENT_BYTES
  if (byteSize > limit) {
    throw new ExtractionProviderError(
      providerName,
      `The document is larger than the ${limit} byte limit for an inline request to this provider.`,
      false,
    )
  }
}

/** Google Gemini via `generateContent`. Primary reader. */
export class GeminiExtractionProvider implements ExtractionProvider {
  readonly name = 'gemini'
  readonly requiresCredentials = true
  readonly readsDocumentContent = true
  /**
   * Gemini takes PDFs inline (`inline_data` with `mime_type: application/pdf`)
   * and images in the same way, so it can read every type the platform stores.
   */
  readonly supportedMediaTypes: readonly string[] = [
    'application/pdf',
    'image/png',
    'image/jpeg',
  ]

  constructor(private readonly options: ExternalProviderOptions) {}

  get model(): string {
    return this.options.model
  }

  isConfigured(): boolean {
    return this.options.apiKey.length > 0 && this.options.model.length > 0
  }

  async extract(request: ExtractionRequest): Promise<ExtractionResult> {
    if (!this.isConfigured()) {
      throw new ExtractionProviderError(
        this.name,
        'The Gemini provider is not configured.',
        false,
      )
    }

    // Refuse before sending anything: a request without content, or with a type
    // this reader cannot take, must not reach the model at all.
    assertProviderCanRead(this, request)
    const content = request.content
    if (content === null) {
      throw new ExtractionProviderError(
        this.name,
        'The document has no stored file, so there is nothing to read.',
        false,
      )
    }
    assertWithinSizeLimit(this.name, this.options, content.byteSize)

    const base =
      this.options.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta'
    const url = `${base}/models/${encodeURIComponent(this.options.model)}:generateContent`

    const { text, model } = await postForJson(
      this.options,
      this.name,
      url,
      { 'x-goog-api-key': this.options.apiKey },
      {
        // The document travels as an `inline_data` part beside the instruction,
        // which is the documented way to send a PDF or image to `generateContent`.
        // The bytes are base64-encoded here and are never logged or stored.
        contents: [
          {
            parts: [
              { text: buildPrompt(request) },
              {
                inlineData: {
                  mimeType: content.mediaType,
                  data: toBase64(content.bytes),
                },
              },
            ],
          },
        ],
        generationConfig: {
          temperature: 0,
          responseMimeType: 'application/json',
        },
      },
      (payload) => {
        const candidate = (payload as { candidates?: unknown[] }).candidates?.[0] as
          | { content?: { parts?: { text?: unknown }[] } }
          | undefined
        const part = candidate?.content?.parts?.[0]?.text
        if (typeof part !== 'string') {
          throw new ExtractionProviderError(
            this.name,
            'The provider response contained no text part.',
            true,
          )
        }
        return part
      },
    )

    const mapped = mapResponse(text, request.fields, this.name)
    return {
      provider: this.name,
      model,
      extractedAt: new Date(),
      ...mapped,
    }
  }
}

/** Groq via the OpenAI-compatible chat completions endpoint. Fallback reader. */
export class GroqExtractionProvider implements ExtractionProvider {
  readonly name = 'groq'
  readonly requiresCredentials = true
  readonly readsDocumentContent = true
  /**
   * Groq's vision endpoint takes images as base64 data URLs. It has no PDF
   * input, so a PDF is refused here and must be routed to a reader that accepts
   * one — sending a PDF to be treated as an image would produce exactly the
   * unsupported guess this contract exists to prevent.
   */
  readonly supportedMediaTypes: readonly string[] = ['image/png', 'image/jpeg']

  constructor(private readonly options: ExternalProviderOptions) {}

  get model(): string {
    return this.options.model
  }

  isConfigured(): boolean {
    return this.options.apiKey.length > 0 && this.options.model.length > 0
  }

  async extract(request: ExtractionRequest): Promise<ExtractionResult> {
    if (!this.isConfigured()) {
      throw new ExtractionProviderError(
        this.name,
        'The Groq provider is not configured.',
        false,
      )
    }

    assertProviderCanRead(this, request)
    const content = request.content
    if (content === null) {
      throw new ExtractionProviderError(
        this.name,
        'The document has no stored file, so there is nothing to read.',
        false,
      )
    }
    assertWithinSizeLimit(this.name, this.options, content.byteSize)

    const base = this.options.baseUrl ?? 'https://api.groq.com/openai/v1'
    const url = `${base}/chat/completions`

    const { text, model } = await postForJson(
      this.options,
      this.name,
      url,
      { authorization: `Bearer ${this.options.apiKey}` },
      {
        model: this.options.model,
        temperature: 0,
        response_format: { type: 'json_object' },
        // OpenAI-compatible multimodal content: a text part plus the image as a
        // base64 data URL, which is Groq's documented input for a local file.
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: buildPrompt(request) },
              {
                type: 'image_url',
                image_url: {
                  url: `data:${content.mediaType};base64,${toBase64(content.bytes)}`,
                },
              },
            ],
          },
        ],
      },
      (payload) => {
        const choice = (payload as { choices?: unknown[] }).choices?.[0] as
          | { message?: { content?: unknown } }
          | undefined
        const content0 = choice?.message?.content
        if (typeof content0 !== 'string') {
          throw new ExtractionProviderError(
            this.name,
            'The provider response contained no message content.',
            true,
          )
        }
        return content0
      },
    )

    const mapped = mapResponse(text, request.fields, this.name)
    return {
      provider: this.name,
      model,
      extractedAt: new Date(),
      ...mapped,
    }
  }
}

/**
 * Tries each compatible provider in order until one succeeds.
 *
 * "Compatible" is decided per request: a provider that cannot read the
 * document's media type is skipped rather than sent a document it would answer
 * from the prompt alone. Bounded by construction — the list is short and fixed
 * at startup. If every compatible provider fails, the last error propagates, so
 * the job is retried or failed on its merits rather than recorded as a
 * successful read.
 */
export class FallbackExtractionProvider implements ExtractionProvider {
  readonly name: string
  readonly requiresCredentials = true
  readonly model: string | null = null
  readonly readsDocumentContent: boolean
  readonly supportedMediaTypes: readonly string[] | null

  constructor(private readonly providers: readonly ExtractionProvider[]) {
    this.name = `fallback(${providers.map((provider) => provider.name).join('>')})`
    this.readsDocumentContent = providers.some(
      (provider) => provider.readsDocumentContent,
    )

    const unconstrained = providers.find(
      (provider) => provider.supportedMediaTypes === null,
    )
    this.supportedMediaTypes =
      unconstrained === undefined
        ? [
            ...new Set(
              providers.flatMap((provider) => provider.supportedMediaTypes ?? []),
            ),
          ]
        : null
  }

  isConfigured(): boolean {
    return this.providers.some((provider) => provider.isConfigured())
  }

  async extract(request: ExtractionRequest): Promise<ExtractionResult> {
    const candidates = this.providers.filter(
      (provider) => provider.isConfigured() && providerCanRead(provider, request),
    )

    if (candidates.length === 0) {
      // Distinguish "nothing is configured" from "nothing can read this file",
      // because the operator's next step is different in each case.
      const configured = this.providers.filter((provider) => provider.isConfigured())
      if (configured.length === 0) {
        throw new ExtractionProviderError(
          this.name,
          'No external extraction provider is configured.',
          false,
        )
      }

      const mediaType =
        request.content === null ? 'a document with no stored file' : request.content.mediaType
      throw new ExtractionProviderError(
        this.name,
        `No configured provider can read ${mediaType}. Configured providers: ${configured
          .map((provider) => `${provider.name} (${provider.supportedMediaTypes?.join(', ') ?? 'any'})`)
          .join('; ')}.`,
        false,
      )
    }

    const failures: string[] = []
    for (const provider of candidates) {
      try {
        return await provider.extract(request)
      } catch (error) {
        failures.push(
          `${provider.name}: ${error instanceof Error ? error.message : 'unknown failure'}`,
        )
      }
    }

    throw new ExtractionProviderError(
      this.name,
      `Every compatible provider failed (${failures.join('; ')}).`,
      true,
    )
  }
}
