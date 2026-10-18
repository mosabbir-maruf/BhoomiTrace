import { useCallback, useEffect, useRef, useState } from "react"
import { fetchDocument } from "@/lib/api/dashboard"
import { apiDownload } from "@/lib/api/client"
import {
  POLL_INTERVAL_MS,
  POLL_MAX_ATTEMPTS,
  describeDocumentExtractionError,
  describeExtractionQueueError,
  enqueueDocumentExtraction,
  fetchDocumentExtraction,
  fetchSelectableParcels,
  isRunningJob,
  isTerminalJobStatus,
  pollDocumentExtractionJob,
  summariseJob,
  type DocumentExtractionLookup,
  type DocumentExtractionReading,
  type JobSummary,
  type ParcelOption,
} from "@/lib/api/documentExtraction"
import { isCurrentSessionDemo, useDataSourceKey } from "@/lib/api/session"
import type { DocumentItem } from "@/lib/api/types"
import {
  documentStatusMeta,
  extractionFieldLabel,
  extractionJobStatusMeta,
  extractionReviewMeta,
} from "@/lib/domain"
import { formatDate, toBengaliDigits } from "@/lib/format"
import { routeHref } from "@/config/navigation"
import { useRoute } from "@/hooks/useHashRoute"
import { useAsync } from "@/hooks/useAsync"
import Load from "@/hooks/useLoader"
import Button from "@/components/ui/Button"
import { Page, Panel, Section } from "@/components/ui/Layout"
import {
  EmptyState,
  ErrorState,
  LoadingRegion,
  Notice,
  Skeleton,
} from "@/components/ui/States"
import StatusBadge from "@/components/ui/StatusBadge"
import { crumbs } from "./shared"

/** A drawn, synthetic page. Selecting a field highlights the line it came from. */
function Preview({
  doc,
  selected,
  onSelect,
}: {
  doc: DocumentItem
  selected: string | null
  onSelect: (id: string) => void
}) {
  return (
    <div
      role="group"
      aria-label="কৃত্রিম নথির পাতা"
      className="rounded-md border border-rule bg-folio p-5 sm:p-6"
    >
      <p className="text-center text-sm text-ink-muted">
        নমুনা নথি, পৃষ্ঠা ১ / {toBengaliDigits(doc.pages ?? 1)}
      </p>
      <p className="mt-1 text-center font-display text-lg font-semibold">
        {doc.name}
      </p>
      <div className="mt-4 space-y-1.5 border-t border-rule pt-3">
        {doc.fields.map((f) => (
          <button
            key={f.id}
            type="button"
            onClick={() => onSelect(f.id)}
            aria-pressed={selected === f.id}
            className={`flex w-full justify-between gap-4 rounded-sm border-2 px-2 py-1 text-left transition-colors duration-150 ${
              selected === f.id
                ? "border-warning bg-highlight"
                : "border-transparent hover:border-rule-strong"
            }`}
          >
            <span className="text-ink-muted">{f.label}</span>
            <span className="font-display">{f.value}</span>
          </button>
        ))}
        {/* Filler lines stand for the rest of the page text. */}
        <span
          aria-hidden="true"
          className="mt-3 block h-2 w-11/12 rounded bg-rule"
        />
        <span aria-hidden="true" className="block h-2 w-3/4 rounded bg-rule" />
        <span aria-hidden="true" className="block h-2 w-5/6 rounded bg-rule" />
      </div>
      <p className="mt-4 text-sm text-ink-muted">
        কাল্পনিক নথি। কোনো আসল কাগজের ছবি বা ওসিআর ফল নয়।
      </p>
    </div>
  )
}

/**
 * The reading a worker already stored for this document, and the one explicit
 * way to ask for a new one.
 *
 * It only reads what exists: the caller's extraction jobs, the newest one for
 * this exact document, then that record's extractions. A run starts only when
 * the signed-in user asks for it and names the record it belongs to, because
 * extraction sends the stored file to an external provider. When nothing is
 * stored it says so instead of showing something that looks like a result.
 */
function AiReading({
  documentId,
  canExtract,
}: {
  documentId: string
  canExtract: boolean
}) {
  const source = useDataSourceKey()
  const demo = isCurrentSessionDemo()
  const { state, retry } = useAsync(
    (signal) => fetchDocumentExtraction(documentId, signal),
    `${source}:document-extraction:${documentId}`,
  )

  // The demo session keeps its own clearly labelled sample fields below. A
  // fixture must never be presented as a model's reading of a real document.
  if (demo) return null

  return (
    <Section
      title="AI থেকে পড়া তথ্য"
      description="নথি থেকে স্বয়ংক্রিয়ভাবে পড়া মান। মূল নথির সঙ্গে মিলিয়ে দেখা ছাড়া এগুলো ভরসা করা যাবে না।"
    >
      {state.status === "loading" && (
        <LoadingRegion label="সংরক্ষিত AI পাঠ আনা হচ্ছে…">
          <div className="space-y-3">
            <Skeleton className="h-20" />
            <Skeleton className="h-20" />
          </div>
        </LoadingRegion>
      )}
      {state.status === "error" && (
        <ErrorState title="সংরক্ষিত AI পাঠ আনা যায়নি" onRetry={retry}>
          {describeDocumentExtractionError(state.error)}
        </ErrorState>
      )}
      {state.status === "success" && (
        <AiReadingBody
          documentId={documentId}
          canExtract={canExtract}
          lookup={state.data}
          onChanged={retry}
        />
      )}
    </Section>
  )
}

/** One already-read field, with what the model read kept apart from what a person decided. */
function AiReadingRow({ reading }: { reading: DocumentExtractionReading }) {
  return (
    <li className="px-5 py-3" data-field={reading.field}>
      <p className="text-sm text-ink-muted">
        {extractionFieldLabel[reading.field]}{" "}
        <span lang="en" className="text-xs">
          ({reading.field})
        </span>
      </p>
      <p className="mt-1 font-semibold">{reading.recordedValue}</p>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs">
        <StatusBadge {...extractionReviewMeta[reading.reviewStatus]} />
        {reading.isUnclear && reading.reviewStatus !== "unclear" && (
          <StatusBadge tone="warning" icon="alert" label="অস্পষ্ট" />
        )}
        {reading.confidence !== null && (
          <span className="text-ink-muted">নিশ্চয়তা: {reading.confidence}</span>
        )}
        {reading.pageReference !== null && (
          <span className="text-ink-muted">পৃষ্ঠা: {reading.pageReference}</span>
        )}
      </div>
      {reading.reviewedValue !== null && (
        <p className="mt-2 text-sm">
          <span className="text-ink-muted">মানুষের দেওয়া সংশোধিত মান:</span>{" "}
          <span className="font-semibold">{reading.reviewedValue}</span>
        </p>
      )}
    </li>
  )
}

function AiReadingBody({
  documentId,
  canExtract,
  lookup,
  onChanged,
}: {
  documentId: string
  canExtract: boolean
  lookup: DocumentExtractionLookup
  onChanged: () => void
}) {
  /** A run this page started, before the reloaded lookup reports it. */
  const [started, setStarted] = useState<JobSummary | null>(null)
  const running =
    lookup.job !== null && isRunningJob(lookup.job.status) ? lookup.job : null
  const tracked = started ?? running
  const handleSettled = useCallback(() => {
    setStarted(null)
    onChanged()
  }, [onChanged])
  const watch = useJobWatch(tracked?.id ?? null, handleSettled)

  const extraction = lookup.extraction
  // The newest attempt, when it is not the one the displayed reading came from.
  const newerAttempt =
    extraction !== null &&
    lookup.job !== null &&
    lookup.job.id !== extraction.jobId
      ? lookup.job
      : null
  const attempt = watch.progress ?? tracked
  const showingProgress = attempt !== null && isRunningJob(attempt.status)

  // Still reading: this is progress, never a result.
  const progress = showingProgress && attempt !== null && (
    <Notice tone="info" title="AI পাঠ চলছে">
      এই নথিটি এখন পড়া হচ্ছে। পাঠটি সার্ভারে চলতে থাকবে, আর শেষ হলে মানগুলো
      আপনাআপনি এখানে দেখা যাবে।
      <span className="mt-1.5 block">
        <StatusBadge {...extractionJobStatusMeta[attempt.status]} />
      </span>
    </Notice>
  )

  const watchFailed = watch.error !== null && (
    <ErrorState title="পাঠের অবস্থা জানা যাচ্ছে না" onRetry={watch.restart}>
      {describeDocumentExtractionError(watch.error)}
    </ErrorState>
  )

  if (extraction !== null) {
    // A provider that does not read content answered from its own fixtures. That
    // is a test double, not a reading of this document, and must not be shown as
    // one even though a finished job exists.
    if (extraction.readsDocumentContent === false) {
      return (
        <Notice tone="warning" title="এই মানগুলো নথি পড়ে পাওয়া নয়">
          এই ফলাফলটি নথি পড়ে নয়, একটি পরীক্ষামূলক নমুনা সরবরাহকারীর কাছ থেকে
          এসেছে। তাই এখানে কোনো AI পাঠ দেখানো হচ্ছে না।
        </Notice>
      )
    }

    if (extraction.readings.length === 0) {
      return (
        <div className="space-y-4">
          {progress}
          <EmptyState title="পাঠ শেষ হয়েছে, কিন্তু কোনো তথ্য পাওয়া যায়নি" icon="clock">
            এই পাঠে খতিয়ান, মৌজা, দাগ, পরিমাণ, অংশ বা মালিকের নামের কোনো মান
            পাওয়া যায়নি। মূল নথিটি পড়ার মতো পরিষ্কার কি না দেখে আবার চেষ্টা করা
            যেতে পারে।
          </EmptyState>
          {canExtract && attempt === null && (
            <AiExtractionLauncher
              documentId={documentId}
              canExtract={canExtract}
              mode="retry"
              onQueued={setStarted}
            />
          )}
        </div>
      )
    }

    return (
      <div className="space-y-4">
        {progress}

        {extraction.needsHumanReview && (
          <Notice tone="warning" title="মানব পর্যালোচনা দরকার">
            এই পাঠে অস্পষ্ট অংশ আছে। কোনো সংখ্যা বা নাম নিশ্চিত করার আগে মূল নথি
            মিলিয়ে দেখতে হবে।
          </Notice>
        )}

        <ul className="divide-y divide-rule rounded-md border border-rule bg-surface">
          {extraction.readings.map((reading) => (
            <AiReadingRow key={reading.id} reading={reading} />
          ))}
        </ul>

        {(extraction.provider !== null ||
          extraction.providerModel !== null) && (
          <p className="text-sm text-ink-muted">
            পাঠ দিয়েছে:{" "}
            <span lang="en">{extraction.provider ?? "অজানা সরবরাহকারী"}</span>
            {extraction.providerModel !== null && (
              <>
                {" ("}
                <span lang="en">{extraction.providerModel}</span>
                {")"}
              </>
            )}
          </p>
        )}

        {newerAttempt !== null && !isRunningJob(newerAttempt.status) && (
          <AiAttemptNotice job={newerAttempt} />
        )}

        <p className="text-sm text-ink-muted">
          এগুলো একটি মডেল স্বয়ংক্রিয়ভাবে পড়েছে; এটি সরকারি বা আইনি যাচাই নয়।
          সিদ্ধান্ত নেওয়ার আগে মূল নথির সঙ্গে মিলিয়ে দেখুন।
        </p>
      </div>
    )
  }

  // No reading to show. Report the newest attempt, or offer to start one.
  if (attempt !== null) {
    return (
      <div className="space-y-4">
        {progress}
        {!showingProgress && watchFailed === null && (
          <p className="text-sm text-ink-muted">পাঠের ফলাফল আনা হচ্ছে…</p>
        )}
        {watchFailed}
      </div>
    )
  }

  if (lookup.job === null) {
    return (
      <AiExtractionLauncher
        documentId={documentId}
        canExtract={canExtract}
        mode="start"
        onQueued={setStarted}
      />
    )
  }

  return (
    <div className="space-y-4">
      <AiAttemptNotice job={lookup.job} />
      {canExtract && (
        <AiExtractionLauncher
          documentId={documentId}
          canExtract={canExtract}
          mode="retry"
          onQueued={setStarted}
        />
      )}
    </div>
  )
}

/** A finished attempt that produced no reading, reported as itself. */
function AiAttemptNotice({ job }: { job: JobSummary }) {
  return (
    <Notice
      tone={job.status === "failed" ? "danger" : "warning"}
      title={extractionJobStatusMeta[job.status].label}
    >
      {job.status === "failed"
        ? "নথিটি পড়া যায়নি, তাই এই চেষ্টা থেকে কোনো মান আসেনি।"
        : "এই চেষ্টাটি কোনো ফলাফল ছাড়াই থেমে গেছে।"}
      {job.lastError !== null && (
        <span className="mt-1 block text-ink-muted">
          কারিগরি কারণ: <span lang="en">{job.lastError}</span>
        </span>
      )}
    </Notice>
  )
}

function isAbort(cause: unknown): boolean {
  return cause instanceof Error && cause.name === "AbortError"
}

/**
 * Follows one job until it settles and then hands control back to the caller.
 *
 * It watches `GET /api/v1/jobs/:jobId` rather than re-reading the whole list, so
 * a run can be followed without loading anything else. A settled job triggers a
 * single reload, because the list is the only thing that knows whether a reading
 * was stored. A read that fails is reported instead of being retried silently,
 * and every wait is abandoned when the page moves on or unmounts.
 */
function useJobWatch(jobId: string | null, onSettled: () => void) {
  const [progress, setProgress] = useState<JobSummary | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const [attempt, setAttempt] = useState(0)
  const lastJobId = useRef<string | null>(null)
  const settledRef = useRef(onSettled)
  settledRef.current = onSettled

  useEffect(() => {
    if (lastJobId.current !== jobId) {
      lastJobId.current = jobId
      setProgress(null)
      setError(null)
    }
    if (jobId === null) return

    const controller = new AbortController()
    pollDocumentExtractionJob(
      jobId,
      (job) => {
        if (!controller.signal.aborted) setProgress(job)
      },
      { intervalMs: POLL_INTERVAL_MS, maxAttempts: POLL_MAX_ATTEMPTS },
      controller.signal,
    ).then(
      (final) => {
        if (controller.signal.aborted) return
        if (isTerminalJobStatus(final.status)) {
          settledRef.current()
        } else {
          // Still running after this attempt's budget: keep watching.
          setAttempt((count) => count + 1)
        }
      },
      (cause: unknown) => {
        if (controller.signal.aborted || isAbort(cause)) return
        setError(cause instanceof Error ? cause : new Error(String(cause)))
      },
    )
    return () => controller.abort()
  }, [jobId, attempt])

  const restart = useCallback(() => setAttempt((count) => count + 1), [])
  return { progress, error, restart }
}

/**
 * The one explicit way to read a document with AI.
 *
 * It never appears on its own initiative: the page shows it only where nothing
 * has been read yet, and it sends nothing until the user picks one of the
 * records they can see and confirms. Queuing a run is the user's decision, so
 * the destination of the stored file is stated before the choice is made.
 */
function AiExtractionLauncher({
  documentId,
  canExtract,
  mode,
  onQueued,
}: {
  documentId: string
  canExtract: boolean
  mode: "start" | "retry"
  onQueued: (job: JobSummary) => void
}) {
  const source = useDataSourceKey()
  const [open, setOpen] = useState(false)
  const [chosen, setChosen] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [queueError, setQueueError] = useState<unknown>(null)
  const controllerRef = useRef<AbortController | null>(null)

  const { state: parcels, retry: reloadParcels } = useAsync(
    (signal) =>
      open
        ? fetchSelectableParcels(signal)
        : Promise.resolve<ParcelOption[]>([]),
    `${source}:extraction-parcels:${open ? "open" : "closed"}`,
  )

  useEffect(() => () => controllerRef.current?.abort(), [])

  if (!canExtract) {
    return (
      <Notice tone="info" title="AI দিয়ে পড়া যাবে না">
        এই নথির মূল ফাইল সংরক্ষিত নেই, তাই পাঠানোর মতো কিছু নেই। নথিটির ফাইল
        সংরক্ষিত থাকলে এখান থেকে AI দিয়ে তথ্য পড়া যাবে।
      </Notice>
    )
  }

  const submit = async () => {
    if (chosen === null) return
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    setSubmitting(true)
    setQueueError(null)
    try {
      const job = await enqueueDocumentExtraction({
        documentId,
        parcelId: chosen,
        signal: controller.signal,
      })
      if (controller.signal.aborted) return
      onQueued(summariseJob(job))
      setOpen(false)
      setChosen(null)
    } catch (cause) {
      if (controller.signal.aborted) return
      setQueueError(cause)
    } finally {
      if (!controller.signal.aborted) setSubmitting(false)
    }
  }

  if (!open) {
    return (
      <div className="space-y-3">
        <Button icon="send" onClick={() => setOpen(true)}>
          {mode === "retry" ? "আবার AI দিয়ে পড়ুন" : "AI দিয়ে তথ্য পড়ুন"}
        </Button>
        <p className="text-sm text-ink-muted">
          শুরু করলে এই নথির সংরক্ষিত PDF ফাইলটি বাইরের কনফিগার করা AI সরবরাহকারীর
          কাছে পাঠানো হবে। পড়া মান প্রস্তাব মাত্র, সরকারি বা আইনি প্রত্যয়ন নয়।
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-4 rounded-md border border-rule bg-surface p-5">
      <p className="text-sm">
        <strong>পাঠানোর আগে জেনে নিন:</strong> শুরু করলে এই নথির সংরক্ষিত PDF
        ফাইলটি বাইরের কনফিগার করা AI সরবরাহকারীর কাছে পাঠানো হবে, এবং ফলে পাওয়া
        মান এই জমির রেকর্ডের সঙ্গে সংরক্ষিত হবে।
      </p>

      {parcels.status === "loading" && (
        <LoadingRegion label="আপনার জমির রেকর্ড আনা হচ্ছে…">
          <Skeleton className="h-24" />
        </LoadingRegion>
      )}

      {parcels.status === "error" && (
        <ErrorState title="জমির রেকর্ড আনা যায়নি" onRetry={reloadParcels}>
          {describeDocumentExtractionError(parcels.error)}
        </ErrorState>
      )}

      {parcels.status === "success" && parcels.data.length === 0 && (
        <EmptyState title="আপনার কোনো জমির রেকর্ড নেই" icon="map">
          পড়া মান জমির রেকর্ডের সঙ্গে যুক্ত হয়ে সংরক্ষিত হয়, তাই পাঠ চালু করতে
          অন্তত একটি রেকর্ড দরকার। আপনার অ্যাকাউন্টে এখন কোনো রেকর্ড দেখা যাচ্ছে
          না, আর এই অ্যাপের পাতা থেকে নতুন রেকর্ড তৈরি করা যায় না — নতুন রেকর্ড
          তৈরি করা যায় API দিয়ে (POST /api/v1/parcels)। রেকর্ড তৈরি হলে এই পাতা
          রিফ্রেশ করে আবার চেষ্টা করুন।
        </EmptyState>
      )}

      {parcels.status === "success" && parcels.data.length > 0 && (
        <fieldset className="space-y-2">
          <legend className="text-sm font-semibold">
            কোন জমির রেকর্ডের সঙ্গে যুক্ত করবেন?
          </legend>
          <p className="text-sm text-ink-muted">
            শুধু আপনার নিজের দেখা রেকর্ড এখানে আছে। অন্য কারও রেকর্ডে পাঠ চালু করা
            যাবে না।
          </p>
          <div className="divide-y divide-rule rounded-sm border border-rule">
            {parcels.data.map((parcel) => (
              <label
                key={parcel.id}
                className={`flex cursor-pointer items-start gap-3 px-4 py-3 text-sm ${
                  chosen === parcel.id ? "bg-accent-soft" : "hover:bg-sunken"
                }`}
              >
                <input
                  type="radio"
                  name={`extraction-parcel-${documentId}`}
                  value={parcel.id}
                  checked={chosen === parcel.id}
                  onChange={() => setChosen(parcel.id)}
                  className="mt-1"
                />
                <span>
                  <span className="block font-semibold">
                    খতিয়ান {toBengaliDigits(parcel.khatianNumber)} · মৌজা{" "}
                    {parcel.mouza}
                  </span>
                  <span className="block text-ink-muted">
                    দাগ{" "}
                    {parcel.dagNumbers.length > 0
                      ? parcel.dagNumbers.map(toBengaliDigits).join(", ")
                      : "নেই"}{" "}
                    · {parcel.upazila}, {parcel.district}
                  </span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      )}

      {queueError !== null && (
        <Notice tone="danger" title="AI পাঠ চালু করা যায়নি">
          {describeExtractionQueueError(queueError)}
        </Notice>
      )}

      <div className="flex flex-wrap gap-3">
        <Button
          icon="send"
          loading={submitting}
          loadingLabel="পাঠ চালু হচ্ছে…"
          disabled={chosen === null || submitting}
          onClick={submit}
        >
          পাঠ শুরু করুন
        </Button>
        <Button
          variant="secondary"
          disabled={submitting}
          onClick={() => {
            setOpen(false)
            setChosen(null)
            setQueueError(null)
          }}
        >
          বাতিল
        </Button>
      </div>

      <p className="text-sm text-ink-muted">
        পাঠ শেষ হলে মানগুলো আপনাআপনি এখানে দেখা যাবে। পড়া মান মূল নথির সঙ্গে মিলিয়ে
        দেখা ছাড়া সিদ্ধান্ত নেওয়া যাবে না।
      </p>
    </div>
  )
}

function Body({ doc }: { doc: DocumentItem }) {
  const [selected, setSelected] = useState<string | null>(
    doc.fields[0]?.id ?? null,
  )
  const [downloading, setDownloading] = useState(false)
  const [downloadError, setDownloadError] = useState("")
  const field = doc.fields.find((f) => f.id === selected)
  const meta: [string, string][] = [
    ["নথি রেফারেন্স", doc.reference ?? "নেই"],
    ["পৃষ্ঠা", doc.pages ? toBengaliDigits(doc.pages) : "নেই"],
    ["জমার তারিখ", doc.date ? formatDate(doc.date) : "এখনো জমা হয়নি"],
  ]

  const handleDownload = async () => {
    setDownloading(true)
    setDownloadError("")
    try {
      const { blob, filename } = await apiDownload(
        `/api/v1/documents/${doc.id}/file`,
      )
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = filename || doc.originalFilename || `${doc.name}.pdf`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } catch {
      setDownloadError("ফাইল ডাউনলোড করা সম্ভব হয়নি।")
    } finally {
      setDownloading(false)
    }
  }

  return (
    <div className="space-y-8">
      {doc.hasStoredFile ? (
        <Notice tone="info" title="সংরক্ষিত নথি">
          এই নথিটির মূল ফাইল BhoomiTrace সুরক্ষিত ফাইল স্টোরেজে সংরক্ষিত রয়েছে।
        </Notice>
      ) : (
        <Notice tone="info" title="নমুনা বিষয়বস্তু">
          এই নথি ও এর তথ্য প্রদর্শনীমূলক। ডেমোতে কোনো নথি স্ক্যান বা যাচাই করা হয়নি।
        </Notice>
      )}
      <Panel className="flex flex-col gap-4 p-5 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <StatusBadge {...documentStatusMeta[doc.status]} />
          <p className="mt-2 max-w-[60ch]">{doc.note}</p>
          {doc.hasStoredFile && (
            <div className="mt-4">
              <Button
                size="sm"
                variant="secondary"
                loading={downloading}
                loadingLabel="ডাউনলোড হচ্ছে…"
                onClick={handleDownload}
              >
                মূল ফাইল ডাউনলোড করুন{" "}
                {doc.originalFilename ? `(${doc.originalFilename})` : ""}
              </Button>
              {downloadError && (
                <p className="mt-1.5 text-xs text-danger">{downloadError}</p>
              )}
            </div>
          )}
        </div>
        <dl className="grid shrink-0 gap-1 text-sm">
          {meta.map(([k, v]) => (
            <div key={k} className="flex gap-2">
              <dt className="text-ink-muted">{k}:</dt>
              <dd
                lang={k === "নথি রেফারেন্স" && doc.reference ? "en" : undefined}
              >
                {v}
              </dd>
            </div>
          ))}
        </dl>
      </Panel>

      <AiReading documentId={doc.id} canExtract={doc.hasStoredFile === true} />

      {doc.fields.length === 0 ? (
        <p className="rounded-md bg-surface px-5 py-4 text-ink-muted">
          {doc.status === "requested"
            ? "নথিটি এখনো জমা হয়নি, তাই দেখানোর মতো কিছু নেই।"
            : "এই নথির নমুনা তথ্য ডেমোতে দেখানো হয় না।"}
        </p>
      ) : (
        <div className="grid gap-6 lg:grid-cols-2 lg:items-start">
          <Section title="নথির পাতা">
            <Preview doc={doc} selected={selected} onSelect={setSelected} />
          </Section>
          <Section
            title="পড়া তথ্য"
            description="একটি তথ্য বেছে নিলে পাতায় তার জায়গা হলুদ হয়।"
          >
            <ul className="divide-y divide-rule rounded-md border border-rule bg-surface">
              {doc.fields.map((f) => (
                <li key={f.id}>
                  <button
                    type="button"
                    aria-pressed={selected === f.id}
                    onClick={() => setSelected(f.id)}
                    className={`flex w-full items-start justify-between gap-4 px-5 py-3 text-left ${
                      selected === f.id ? "bg-accent-soft" : "hover:bg-sunken"
                    }`}
                  >
                    <span>
                      <span className="block text-sm text-ink-muted">
                        {f.label}
                      </span>
                      <span className="font-semibold">{f.value}</span>
                    </span>
                    {f.unclear && (
                      <StatusBadge tone="warning" icon="alert" label="অস্পষ্ট" />
                    )}
                  </button>
                </li>
              ))}
            </ul>
            {field && (
              <p className="mt-3 text-sm" role="status">
                <span className="text-ink-muted">উৎস:</span> {field.source}
                {field.unclear &&
                  " — এই অংশটি পরিষ্কার পড়া যায়নি; অফিসে মিলিয়ে দেখা দরকার হতে পারে।"}
              </p>
            )}
          </Section>
        </div>
      )}

      <nav aria-label="সংশ্লিষ্ট" className="flex flex-wrap gap-x-6">
        {doc.applicationId && (
          <a
            href={routeHref("application", doc.applicationId)}
            className="text-link"
          >
            সংশ্লিষ্ট আবেদন
          </a>
        )}
        {doc.parcelId && (
          <a href={routeHref("record", doc.parcelId)} className="text-link">
            সংশ্লিষ্ট জমির রেকর্ড
          </a>
        )}
        <a href={routeHref("documents")} className="text-link">
          ← সব নথিতে ফিরুন
        </a>
      </nav>
    </div>
  )
}

export default function DocumentDetailPage() {
  const { param = "" } = useRoute()
  return (
    <Load
      load={(signal) => fetchDocument(param, signal)}
      loadKey={param}
      framed
      notFound={{
        title: "নথিটি পাওয়া যায়নি",
        backHref: routeHref("documents"),
        backLabel: "সব নথি দেখুন",
      }}
    >
      {({ document }) => (
        <Page
          title={document.name}
          breadcrumbs={crumbs("document", document.name)}
        >
          <Body doc={document} />
        </Page>
      )}
    </Load>
  )
}
