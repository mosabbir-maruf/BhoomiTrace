import { z } from 'zod'

import type { ExtractionField } from '../db/schema/enums.js'
import type { BoundingBox } from '../db/schema/types.js'
import {
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
 * The request/response mapping, timeout handling, JSON validation, and failure
 * behaviour are covered by tests against an injected transport. **No live call
 * has been made**, and none can be made without credentials the project does not
 * hold. The endpoint paths below follow each vendor's documented REST shape, but
 * the model identifiers are supplied by configuration rather than hard-coded,
 * because a model name is a moving target: an operator must confirm the
 * identifier in the provider's console before enabling these adapters.
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
  /** Injectable transport so tests never touch the network. */
  fetchImpl?: FetchImplementation
  baseUrl?: string
}

/** Builds the instruction sent to an external reader. */
function buildPrompt(request: ExtractionRequest): string {
  return [
    'You are reading a land record for a records-verification system.',
    'Return only JSON of the form:',
    '{"fields":[{"field":"khatian","value":"...","confidence":0.0,"unclear":false,',
    '"pageNumber":1,"pageReference":"...","boundingBox":null}]}',
    '',
    'Rules you must follow:',
    '- Return exactly these fields: ' + request.fields.join(', ') + '.',
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

/** Google Gemini via `generateContent`. Primary reader. */
export class GeminiExtractionProvider implements ExtractionProvider {
  readonly name = 'gemini'
  readonly requiresCredentials = true

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

    const base =
      this.options.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta'
    const url = `${base}/models/${encodeURIComponent(this.options.model)}:generateContent`

    const { text, model } = await postForJson(
      this.options,
      this.name,
      url,
      { 'x-goog-api-key': this.options.apiKey },
      {
        contents: [{ parts: [{ text: buildPrompt(request) }] }],
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
        messages: [{ role: 'user', content: buildPrompt(request) }],
      },
      (payload) => {
        const choice = (payload as { choices?: unknown[] }).choices?.[0] as
          | { message?: { content?: unknown } }
          | undefined
        const content = choice?.message?.content
        if (typeof content !== 'string') {
          throw new ExtractionProviderError(
            this.name,
            'The provider response contained no message content.',
            true,
          )
        }
        return content
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
 * Tries each provider in order until one succeeds.
 *
 * Bounded by construction: the list is short and fixed at startup. If every
 * provider fails, the last error propagates, so the job is retried or failed on
 * its merits rather than recorded as a successful read.
 */
export class FallbackExtractionProvider implements ExtractionProvider {
  readonly name: string
  readonly requiresCredentials = true
  readonly model: string | null = null

  constructor(private readonly providers: readonly ExtractionProvider[]) {
    this.name = `fallback(${providers.map((provider) => provider.name).join('>')})`
  }

  isConfigured(): boolean {
    return this.providers.some((provider) => provider.isConfigured())
  }

  async extract(request: ExtractionRequest): Promise<ExtractionResult> {
    const configured = this.providers.filter((provider) => provider.isConfigured())
    if (configured.length === 0) {
      throw new ExtractionProviderError(
        this.name,
        'No external extraction provider is configured.',
        false,
      )
    }

    const failures: string[] = []
    for (const provider of configured) {
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
      `Every configured provider failed (${failures.join('; ')}).`,
      true,
    )
  }
}
