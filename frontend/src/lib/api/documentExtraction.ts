import { ApiError, apiGet, apiPost } from "./client"
import { isCurrentSessionDemo } from "./session"
import type {
  BackendParcel,
  Extraction,
  ExtractionField,
  ExtractionReviewStatus,
  Page,
  ProcessingJob,
  ProcessingJobStatus,
} from "./types"

/**
 * Reading back — and, on request, starting — the extraction of a document.
 *
 * The document detail page must show what the model read for *this* document and
 * nothing else, so this module uses four existing endpoints rather than asking
 * for anything new:
 *
 * - `GET /api/v1/jobs?kind=document_extraction&limit=50` — the caller's own jobs,
 *   newest first, each carrying its `sourceDocumentId`, its `parcelId` and the
 *   `result` the worker wrote. An applicant only ever sees jobs they requested.
 * - `GET /api/v1/parcels/:parcelId/extractions` — every stored reading for that
 *   record, both provider readings and hand-typed ones.
 * - `POST /api/v1/jobs` — queues a `document_extraction` for one parcel and one
 *   source document. This is the only way a reading starts; nothing here runs
 *   extraction implicitly, and the caller must ask for it.
 * - `GET /api/v1/jobs/:jobId` — the job's own state, so a queued run can be
 *   followed without re-reading the whole list.
 *
 * A queued job is owned by the account that asked for it, and an extraction job
 * needs a parcel record the same account can see, because the readings are
 * stored against that record.
 */

/** Statuses in which a worker may still be working on the job. */
const RUNNING_JOB_STATUSES: readonly ProcessingJobStatus[] = [
  "queued",
  "processing",
  "retry_pending",
]

/** Terminal statuses whose stored result is a finished reading. */
const READING_JOB_STATUSES: readonly ProcessingJobStatus[] = [
  "completed",
  "review_required",
]

/** How long to wait between job status reads, and how many to make. */
export const POLL_INTERVAL_MS = 4000
export const POLL_MAX_ATTEMPTS = 45

/** The six fields a land record is read for, in the order they are read. */
export const EXTRACTION_FIELD_ORDER: readonly ExtractionField[] = [
  "khatian",
  "mouza",
  "dag",
  "area",
  "share",
  "owner",
]

/** True while the worker may still change this job. */
export function isRunningJob(status: ProcessingJobStatus): boolean {
  return RUNNING_JOB_STATUSES.includes(status)
}

/** True once the job has settled; the worker will not touch it again. */
export function isTerminalJobStatus(status: ProcessingJobStatus): boolean {
  return !isRunningJob(status)
}

/** Just enough of a job to report its state, never its payload. */
export interface JobSummary {
  id: string
  status: ProcessingJobStatus
  /** A failure summary the worker redacted for operators, or `null`. */
  lastError: string | null
}

/** One stored reading, reduced to what the page shows. */
export interface DocumentExtractionReading {
  id: string
  field: ExtractionField
  /** What the model read. Never overwritten by a correction. */
  recordedValue: string
  /** What a person decided instead, when one has. */
  reviewedValue: string | null
  reviewStatus: ExtractionReviewStatus
  isUnclear: boolean
  confidence: string | null
  pageReference: string | null
}

export interface DocumentExtraction {
  jobId: string
  /** The job kept unreadable readings, so a person must look before trusting them. */
  needsHumanReview: boolean
  provider: string | null
  providerModel: string | null
  /**
   * Whether the provider read the document itself. `false` means the readings
   * are a synthetic double's fixtures; `null` means the job did not say.
   */
  readsDocumentContent: boolean | null
  readings: DocumentExtractionReading[]
}

/**
 * What the page can say about one document: the newest attempt, and the stored
 * reading a finished attempt left behind.
 *
 * They are separate because a failed attempt must be reported as a failure while
 * an earlier reading, if one exists, is still the only real reading there is.
 */
export interface DocumentExtractionLookup {
  /** The newest extraction job for this document, whatever its state. */
  job: JobSummary | null
  /** The reading stored by the newest job that finished with one. */
  extraction: DocumentExtraction | null
}

/** A parcel record the caller can attach an extraction to. */
export interface ParcelOption {
  id: string
  khatianNumber: string
  mouza: string
  dagNumbers: string[]
  upazila: string
  district: string
}

function toJobSummary(job: ProcessingJob): JobSummary {
  return { id: job.id, status: job.status, lastError: job.lastError }
}

/** Reduces a job to its state, so a page can report it without its payload. */
export function summariseJob(job: ProcessingJob): JobSummary {
  return toJobSummary(job)
}

/**
 * The extraction identifiers a finished job recorded, or `null` when it
 * recorded none.
 *
 * `null` and `[]` are different answers: an empty list is a job that read
 * nothing, while a missing list means the job cannot say which rows are its own.
 */
export function readExtractionIds(
  result: Record<string, unknown> | null,
): string[] | null {
  if (result === null) return null
  const raw = result.extractionIds
  if (!Array.isArray(raw)) return null
  return raw.filter((id): id is string => typeof id === "string")
}

function textField(
  source: Record<string, unknown> | null,
  key: string,
): string | null {
  const value = source?.[key]
  return typeof value === "string" && value !== "" ? value : null
}

function flagField(
  source: Record<string, unknown> | null,
  key: string,
): boolean | null {
  const value = source?.[key]
  return typeof value === "boolean" ? value : null
}

/** True when this job is a `document_extraction` of exactly this document. */
function isJobOfDocument(job: ProcessingJob, documentId: string): boolean {
  return (
    job.kind === "document_extraction" &&
    job.sourceDocumentId === documentId
  )
}

/** True when a finished job kept a result the page could read back. */
function isStoredReading(job: ProcessingJob): boolean {
  return READING_JOB_STATUSES.includes(job.status) && job.result !== null
}

/**
 * The newest extraction job for one document, whatever its state, or `null`.
 *
 * This is what the page reports: a queued or failed attempt is still the honest
 * answer to "what happened when this document was read", and hiding it behind an
 * older success would say the newest attempt worked when it did not.
 */
export function findLatestDocumentExtractionJob(
  jobs: readonly ProcessingJob[],
  documentId: string,
): ProcessingJob | null {
  return jobs.find((job) => isJobOfDocument(job, documentId)) ?? null
}

/**
 * The newest finished job for one document that kept a reading, or `null`.
 *
 * The list arrives newest first, so the first match is the most recent reading.
 * A queued, processing, failed or cancelled job is not a reading and must never
 * be shown as one; another document's job is ignored even when it is newer.
 */
export function findDocumentExtractionJob(
  jobs: readonly ProcessingJob[],
  documentId: string,
): ProcessingJob | null {
  return (
    jobs.find((job) => isJobOfDocument(job, documentId) && isStoredReading(job)) ??
    null
  )
}

export interface DocumentExtractionFilter {
  documentId: string
  /** `result.extractionIds` from the matching job, or `null` when absent. */
  extractionIds: string[] | null
}

/**
 * Keeps only the readings that belong to one document.
 *
 * Three independent guards, because showing a value the model did not read for
 * this document is worse than showing nothing at all:
 *
 * - `sourceDocumentId` must be this document, which also excludes a hand-typed
 *   value, since a manual entry has no source document;
 * - `origin` must be `provider`, so a manual entry can never be dressed up as
 *   model output; and
 * - when the job listed its `extractionIds`, the row must be in that list, so an
 *   earlier reading of the same document is not mixed in with this job's.
 */
export function selectDocumentExtractions(
  items: readonly Extraction[],
  filter: DocumentExtractionFilter,
): Extraction[] {
  const ids =
    filter.extractionIds === null ? null : new Set(filter.extractionIds)
  return items.filter(
    (item) =>
      item.sourceDocumentId === filter.documentId &&
      item.origin === "provider" &&
      (ids === null || ids.has(item.id)),
  )
}

const FIELD_INDEX = new Map<ExtractionField, number>(
  EXTRACTION_FIELD_ORDER.map((field, index) => [field, index]),
)

/** Orders readings the way a record is read, with ties broken by row id. */
export function orderReadings(readings: readonly Extraction[]): Extraction[] {
  return [...readings].sort((a, b) => {
    const left = FIELD_INDEX.get(a.field) ?? EXTRACTION_FIELD_ORDER.length
    const right = FIELD_INDEX.get(b.field) ?? EXTRACTION_FIELD_ORDER.length
    return left === right ? a.id.localeCompare(b.id) : left - right
  })
}

function presentValue(value: string | null): string | null {
  return value === null || value === "" ? null : value
}

/** The first non-empty value a set of rows reports for one column. */
function firstValue(
  rows: readonly Extraction[],
  pick: (row: Extraction) => string | null,
): string | null {
  for (const row of rows) {
    const value = pick(row)
    if (value !== null && value !== "") return value
  }
  return null
}

function toExtraction(job: ProcessingJob, rows: readonly Extraction[]): DocumentExtraction {
  const matched = orderReadings(
    selectDocumentExtractions(rows, {
      documentId: job.sourceDocumentId ?? "",
      extractionIds: readExtractionIds(job.result),
    }),
  )

  const readings: DocumentExtractionReading[] = matched.map((item) => ({
    id: item.id,
    field: item.field,
    recordedValue: item.recordedValue,
    reviewedValue: presentValue(item.reviewedValue),
    reviewStatus: item.reviewStatus,
    isUnclear: item.isUnclear,
    confidence: presentValue(item.confidence),
    pageReference: presentValue(item.pageReference),
  }))

  return {
    jobId: job.id,
    needsHumanReview:
      job.status === "review_required" ||
      readings.some(
        (reading) => reading.isUnclear || reading.reviewStatus === "unclear",
      ),
    provider:
      textField(job.result, "provider") ??
      firstValue(matched, (row) => row.provider),
    providerModel:
      textField(job.result, "model") ??
      firstValue(matched, (row) => row.providerModel),
    readsDocumentContent: flagField(job.result, "readsDocumentContent"),
    readings,
  }
}

/**
 * Loads what is known about this document's extraction.
 *
 * A `null` job is not an error: it means nobody has asked for this document to
 * be read yet. A job that is still running, or one that failed, is reported as
 * itself rather than as a reading.
 */
export async function fetchDocumentExtraction(
  documentId: string,
  signal?: AbortSignal,
): Promise<DocumentExtractionLookup> {
  // The demo session shows its own labelled sample fields; the live API is not
  // consulted, so a fixture can never be presented as a model's reading.
  if (isCurrentSessionDemo()) return { job: null, extraction: null }

  const jobs = await apiGet<Page<ProcessingJob>>(
    "/api/v1/jobs?kind=document_extraction&limit=50",
    signal,
  )
  const latest = findLatestDocumentExtractionJob(jobs.items, documentId)
  if (latest === null) return { job: null, extraction: null }

  const job = toJobSummary(latest)
  const reading = findDocumentExtractionJob(jobs.items, documentId)
  // Without a parcel the readings of the job cannot be addressed, so there is
  // nothing this page can honestly show for it.
  if (reading === null || reading.parcelId === null) {
    return { job, extraction: null }
  }

  const page = await apiGet<{ items: Extraction[] }>(
    `/api/v1/parcels/${encodeURIComponent(reading.parcelId)}/extractions`,
    signal,
  )

  return { job, extraction: toExtraction(reading, page.items) }
}

/**
 * Reads the parcels the signed-in caller can attach an extraction to.
 *
 * It is the same list the applicant dashboard shows: an applicant sees only the
 * records they own, so no job can be aimed at somebody else's filing, and no
 * parcel identifier is ever invented here.
 */
export async function fetchSelectableParcels(
  signal?: AbortSignal,
): Promise<ParcelOption[]> {
  const page = await apiGet<Page<BackendParcel>>("/api/v1/parcels?limit=50", signal)
  return page.items.map((parcel) => ({
    id: parcel.id,
    khatianNumber: parcel.khatianNumber,
    mouza: parcel.mouza,
    dagNumbers: Array.isArray(parcel.dagNumbers) ? [...parcel.dagNumbers] : [],
    upazila: parcel.upazila,
    district: parcel.district,
  }))
}

/**
 * Queues one extraction of this document against one parcel record.
 *
 * The caller must be able to see both the parcel and the document; the server
 * answers `404` for a record the account cannot read, so this cannot be used to
 * reach into somebody else's filing. Queuing is always an explicit act: nothing
 * in this module starts a job by itself.
 */
export async function enqueueDocumentExtraction(input: {
  documentId: string
  parcelId: string
  signal?: AbortSignal
}): Promise<ProcessingJob> {
  return apiPost<ProcessingJob>(
    "/api/v1/jobs",
    {
      kind: "document_extraction",
      parcelId: input.parcelId,
      sourceDocumentId: input.documentId,
    },
    input.signal,
  )
}

/** Reads one job's own state, for following a run that was just queued. */
export async function fetchJob(
  jobId: string,
  signal?: AbortSignal,
): Promise<JobSummary> {
  return toJobSummary(
    await apiGet<ProcessingJob>(`/api/v1/jobs/${encodeURIComponent(jobId)}`, signal),
  )
}

function abortError(): Error {
  const error = new Error("The request was aborted.")
  error.name = "AbortError"
  return error
}

/** Waits, unless the caller has already given up. */
function wait(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError())
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    function onAbort() {
      clearTimeout(timer)
      reject(abortError())
    }
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

export interface PollOptions {
  /** Milliseconds between status reads. */
  intervalMs?: number
  /** How many status reads to make before returning the job as still running. */
  maxAttempts?: number
}

/**
 * Follows one job until it settles.
 *
 * Returns the last job seen, which may still be running when `maxAttempts` is
 * reached: a job that has not settled is reported as running rather than as a
 * result. A status read that fails is thrown, so a page can say the job could
 * not be followed instead of showing a stale state as the current one.
 */
export async function pollDocumentExtractionJob(
  jobId: string,
  onProgress?: (job: JobSummary) => void,
  options: PollOptions = {},
  signal?: AbortSignal,
): Promise<JobSummary> {
  const intervalMs = options.intervalMs ?? POLL_INTERVAL_MS
  const maxAttempts = options.maxAttempts ?? POLL_MAX_ATTEMPTS

  let job = await fetchJob(jobId, signal)
  onProgress?.(job)

  let attempts = 0
  while (!isTerminalJobStatus(job.status) && attempts < maxAttempts) {
    attempts += 1
    await wait(intervalMs, signal)
    job = await fetchJob(jobId, signal)
    onProgress?.(job)
  }

  return job
}

/**
 * A message a signed-in user can act on when the reading cannot be loaded.
 *
 * The document itself loaded, so the copy is about the reading rather than the
 * document, and it never suggests a reading exists when it does not.
 */
export function describeDocumentExtractionError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) {
      return "আপনার সেশন শেষ হয়ে গেছে। আবার সাইন ইন করে আবার চেষ্টা করুন।"
    }
    if (error.status === 403) {
      return "এই AI পাঠটি দেখার অনুমতি আপনার নেই।"
    }
    if (error.status === 404) {
      return "এই নথির AI পাঠটি আর পাওয়া যাচ্ছে না।"
    }
  }
  return "সংরক্ষিত AI পাঠ আনা যায়নি। ইন্টারনেট সংযোগ পরীক্ষা করে আবার চেষ্টা করুন।"
}

/** A message for a queue request the server refused, or that never arrived. */
export function describeExtractionQueueError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) {
      return "আপনার সেশন শেষ হয়ে গেছে। আবার সাইন ইন করে আবার চেষ্টা করুন।"
    }
    if (error.status === 403) {
      return "এই জমির রেকর্ডে AI পাঠ চালু করার অনুমতি আপনার নেই।"
    }
    if (error.status === 404) {
      return "জমির রেকর্ডটি বা নথিটি আর পাওয়া যাচ্ছে না। পাতা রিফ্রেশ করে আবার দেখুন।"
    }
    if (error.status === 409) {
      return "এই পাঠটি এখন চালু করা যাচ্ছে না। একটু পরে আবার চেষ্টা করুন।"
    }
    if (error.status === 400 || error.status === 422) {
      return "অনুরোধটি গ্রহণ করা যায়নি। পাতা রিফ্রেশ করে আবার চেষ্টা করুন।"
    }
  }
  return "AI পাঠ চালু করা যায়নি। ইন্টারনেট সংযোগ পরীক্ষা করে আবার চেষ্টা করুন।"
}
