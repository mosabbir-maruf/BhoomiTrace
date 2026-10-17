import { eq } from 'drizzle-orm'

import type { Database } from '../db/client.js'
import { sourceDocuments } from '../db/schema/documents.js'
import type { ExtractionField } from '../db/schema/enums.js'
import { extractionFieldEnum } from '../db/schema/enums.js'
import { users, type User } from '../db/schema/users.js'
import {
  assertProviderCanRead,
  ALL_EXTRACTION_FIELDS,
  type ExtractionProvider,
  type ExtractionSourceContent,
} from '../extraction/provider.js'
import { NotFoundError, ProviderUnavailableError } from '../lib/errors.js'
import { systemActor } from '../services/audit.js'
import { persistExtractionResult } from '../services/extractions.js'
import {
  assertJobLeaseHeld,
  type ClaimedJob,
  type JobFence,
} from '../services/jobs.js'
import { reconcileParcel } from '../services/reconciliation.js'
import { generateReadinessReport } from '../services/readiness.js'
import { readStoredFile, StoredFileError } from '../services/storage.js'

/**
 * Does the actual work of a claimed job.
 *
 * Everything here is provider-independent: it asks the configured
 * `ExtractionProvider` for readings and stores them, with no knowledge of
 * whether those readings came from the deterministic mock or a hosted model.
 *
 * Three deliberate properties:
 *
 * - **The slow call happens outside a transaction.** A provider call can take
 *   tens of seconds; holding a database transaction open across it would pin a
 *   connection and block other work. The claim's lease — not a transaction — is
 *   what reserves the job, which is precisely why the lease exists.
 * - **Every write is fenced on the lease.** The ownership check is the first
 *   statement of the transaction that writes a result, so a worker that lost its
 *   lease mid-read rolls back instead of adding a second copy of the same work.
 * - **Worker writes are attributed to the system.** An extraction produced by the
 *   worker is recorded as a system action naming the worker, not as an action by
 *   the person who requested it. Pretending a human performed an automated read
 *   would misstate the record; the requester is visible on the job and in the
 *   audit detail.
 */

export interface JobProcessorContext {
  database: Database
  provider: ExtractionProvider
  rulesVersion: string
  /** Identifies the lease this work is fenced on. */
  fence: JobFence
  /** Private storage directory, so a reader can be given the real document. */
  uploadDir: string
  /** Largest document that may be handed to a reader. */
  maxContentBytes: number
  log: {
    info: (details: Record<string, unknown>, message: string) => void
    warn: (details: Record<string, unknown>, message: string) => void
    error: (details: Record<string, unknown>, message: string) => void
  }
}

export interface JobProcessOutcome {
  status: 'completed' | 'review_required'
  result: Record<string, unknown>
}

/** Validates and narrows the fields a job asked for. */
function requestedFields(payload: Record<string, unknown> | null): ExtractionField[] {
  const raw = payload?.['fields']
  if (!Array.isArray(raw) || raw.length === 0) return [...ALL_EXTRACTION_FIELDS]

  const known = new Set<string>(extractionFieldEnum.enumValues)
  const fields = raw.filter(
    (entry): entry is ExtractionField =>
      typeof entry === 'string' && known.has(entry),
  )

  return fields.length > 0 ? fields : [...ALL_EXTRACTION_FIELDS]
}

function readString(
  payload: Record<string, unknown> | null,
  key: string,
): string | null {
  const value = payload?.[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** Runs a claimed job to completion. */
export async function processClaimedJob(
  context: JobProcessorContext,
  job: ClaimedJob,
): Promise<JobProcessOutcome> {
  switch (job.kind) {
    case 'document_extraction':
      return processDocumentExtraction(context, job)
    case 'parcel_reconciliation':
      return processParcelReconciliation(context, job)
    case 'readiness_report':
      return processReadinessReport(context, job)
    default: {
      // Exhaustiveness guard: adding a job kind without a handler becomes a
      // compile error here, and a runtime failure rather than a silent no-op.
      const unhandled: never = job.kind
      throw new NotFoundError(
        `No handler is implemented for job kind "${String(unhandled)}".`,
      )
    }
  }
}

async function processDocumentExtraction(
  context: JobProcessorContext,
  job: ClaimedJob,
): Promise<JobProcessOutcome> {
  if (job.sourceDocumentId === null) {
    throw new NotFoundError('The extraction job names no source document.')
  }

  const parcelId = job.parcelId ?? readString(job.payload, 'parcelId')
  if (parcelId === null) {
    throw new NotFoundError('The extraction job names no parcel.')
  }

  const documentRows = await context.database.orm
    .select()
    .from(sourceDocuments)
    .where(eq(sourceDocuments.id, job.sourceDocumentId))
    .limit(1)

  const document = documentRows[0]
  if (document === undefined) {
    throw new NotFoundError(
      'The extraction job names a source document that does not exist.',
    )
  }

  const fields = requestedFields(job.payload)

  // A reader is given the document itself. Loading is skipped entirely for a
  // provider that does not read content, so the synthetic double still works
  // against a metadata-only record in tests.
  const content = context.provider.readsDocumentContent
    ? await loadSourceContent(context, document)
    : null

  const request = {
    sourceDocumentId: document.id,
    title: document.title,
    reference: document.reference,
    pageCount: document.pageCount,
    fields,
    content,
  }

  // Decide readability *before* calling the provider, so "nothing can read this
  // file" is reported as itself rather than as an opaque provider error.
  assertProviderCanRead(context.provider, request)

  // The slow, fallible part. No transaction is open here, so a provider that
  // takes thirty seconds does not hold a database connection while it works.
  const extraction = await context.provider.extract(request)

  const stored = await context.database.orm.transaction(async (tx) => {
    // The fence: if this worker no longer holds the job, nothing is written.
    await assertJobLeaseHeld(tx, context.fence)

    return persistExtractionResult(tx, {
      result: extraction,
      parcelId,
      sourceDocumentId: document.id,
      actor: systemActor('extraction-worker'),
    })
  })

  const unclearCount = stored.filter((row) => row.isUnclear).length

  context.log.info(
    {
      jobId: job.id,
      provider: extraction.provider,
      readsDocumentContent: context.provider.readsDocumentContent,
      fieldCount: stored.length,
      unclearCount,
    },
    'extraction job produced readings',
  )

  return {
    // Unreadable readings are a normal outcome that needs a person, not an
    // error, so the job reports `review_required` rather than failing.
    status: unclearCount > 0 ? 'review_required' : 'completed',
    result: {
      provider: extraction.provider,
      model: extraction.model,
      // Say plainly whether these readings came from the document or from a
      // synthetic double, so a result is never mistaken for a real read.
      readsDocumentContent: context.provider.readsDocumentContent,
      hadStoredContent: content !== null,
      extractionIds: stored.map((row) => row.id),
      fieldCount: stored.length,
      unclearCount,
      warnings: extraction.warnings,
      parcelId,
      sourceDocumentId: document.id,
    },
  }
}

/**
 * Reads the stored document a job names, bounded and verified.
 *
 * The path comes from the record's storage key, never from the job payload or a
 * caller, and the bytes stay in this process: they are handed to the provider and
 * are never written to a job payload, a log line, or an audit row.
 */
async function loadSourceContent(
  context: JobProcessorContext,
  document: typeof sourceDocuments.$inferSelect,
): Promise<ExtractionSourceContent> {
  if (document.storageKey === null) {
    throw new ProviderUnavailableError(
      'The document has no stored file, so a provider that reads documents cannot be used for it.',
    )
  }

  if (document.contentType === null) {
    throw new ProviderUnavailableError(
      'The document has a stored file but no recorded media type, so it cannot be sent to a reader.',
    )
  }

  try {
    const loaded = await readStoredFile(context.uploadDir, document.storageKey, {
      maxBytes: context.maxContentBytes,
      expectedSha256: document.checksumSha256,
    })

    return {
      mediaType: document.contentType,
      bytes: loaded.bytes,
      byteSize: loaded.byteSize,
      sha256: loaded.sha256,
      originalFilename: document.originalFilename,
    }
  } catch (error) {
    if (error instanceof StoredFileError) {
      // The reason is named; no path, digest, or byte content is exposed.
      throw new ProviderUnavailableError(
        `The stored document could not be read (${error.reason}). Nothing was extracted.`,
      )
    }
    throw error
  }
}

async function processParcelReconciliation(
  context: JobProcessorContext,
  job: ClaimedJob,
): Promise<JobProcessOutcome> {
  const parcelId = job.parcelId ?? readString(job.payload, 'parcelId')
  if (parcelId === null) {
    throw new NotFoundError('The reconciliation job names no parcel.')
  }

  const user = await loadRequester(context.database, job)

  const reconciliation = await reconcileParcel(context.database, {
    user,
    parcelId,
    persist: true,
    rulesVersion: context.rulesVersion,
    fence: context.fence,
  })

  const blocking = reconciliation.rules.filter(
    (rule) => rule.outcome === 'fail' && rule.severity === 'high',
  )

  return {
    status: blocking.length > 0 ? 'review_required' : 'completed',
    result: {
      outcome: reconciliation.summary.outcome,
      counts: reconciliation.summary.counts,
      raisedFindings: reconciliation.raisedFindings.length,
      blockingHighSeverity: blocking.length,
      parcelId,
    },
  }
}

async function processReadinessReport(
  context: JobProcessorContext,
  job: ClaimedJob,
): Promise<JobProcessOutcome> {
  const parcelId = job.parcelId ?? readString(job.payload, 'parcelId')
  if (parcelId === null) {
    throw new NotFoundError('The readiness job names no parcel.')
  }

  const user = await loadRequester(context.database, job)

  const report = await generateReadinessReport(context.database, {
    user,
    parcelId,
    rulesVersion: context.rulesVersion,
    fence: context.fence,
  })

  return {
    status: report.outcome === 'not_ready' ? 'review_required' : 'completed',
    result: {
      readinessReportId: report.id,
      outcome: report.outcome,
      counts: report.counts,
      itemCount: report.items.length,
      parcelId,
    },
  }
}

/** Loads the account a job is attributed to. */
async function loadRequester(
  database: Database,
  job: ClaimedJob,
): Promise<User> {
  if (job.requestedBy === null) {
    throw new NotFoundError(
      'This job has no requesting account, so its result cannot be attributed.',
    )
  }

  const rows = await database.orm
    .select()
    .from(users)
    .where(eq(users.id, job.requestedBy))
    .limit(1)

  const user = rows[0]
  if (user === undefined) {
    throw new NotFoundError(
      'The account that requested this job no longer exists.',
    )
  }
  return user
}
