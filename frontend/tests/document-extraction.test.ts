import test from "node:test"
import assert from "node:assert/strict"

import { ApiError } from "../src/lib/api/client.ts"
import {
  describeDocumentExtractionError,
  describeExtractionQueueError,
  enqueueDocumentExtraction,
  EXTRACTION_FIELD_ORDER,
  fetchDocumentExtraction,
  fetchJob,
  fetchSelectableParcels,
  findDocumentExtractionJob,
  findLatestDocumentExtractionJob,
  isRunningJob,
  isTerminalJobStatus,
  orderReadings,
  pollDocumentExtractionJob,
  readExtractionIds,
  selectDocumentExtractions,
  summariseJob,
} from "../src/lib/api/documentExtraction.ts"
import { setSession, startDemo } from "../src/lib/api/session.ts"
import type {
  BackendParcel,
  Extraction,
  ExtractionField,
  ProcessingJob,
} from "../src/lib/api/types.ts"

/**
 * Contract tests for reading back — and explicitly starting — an extraction.
 *
 * The page must show the values a worker already saved for one document and
 * nothing else, so these cover the ways that could go wrong: showing another
 * document's (or a hand-typed) value as a model reading, presenting a job that
 * has no result as a finished reading, and reporting a failed or still-running
 * attempt as success. The queue tests use mocked HTTP only; no paid provider is
 * ever called.
 */

const NOW = "2026-01-01T00:00:00.000Z"
const DOC_A = "11111111-1111-4111-8111-111111111111"
const DOC_B = "22222222-2222-4222-8222-222222222222"
const PARCEL = "33333333-3333-4333-8333-333333333333"
const JOB_A = "44444444-4444-4444-8444-444444444444"

function job(overrides: Partial<ProcessingJob> = {}): ProcessingJob {
  return {
    id: JOB_A,
    kind: "document_extraction",
    status: "completed",
    parcelId: PARCEL,
    sourceDocumentId: DOC_A,
    requestedBy: null,
    idempotencyKey: null,
    attemptCount: 1,
    maxAttempts: 3,
    availableAt: NOW,
    leasedUntil: null,
    lockedBy: null,
    lastError: null,
    payload: null,
    result: null,
    startedAt: NOW,
    finishedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

function extraction(overrides: Partial<Extraction> = {}): Extraction {
  return {
    id: "ext-1",
    parcelId: PARCEL,
    sourceDocumentId: DOC_A,
    pageId: null,
    field: "khatian",
    recordedValue: "",
    reviewedValue: null,
    reviewStatus: "pending",
    confidence: null,
    isUnclear: false,
    pageReference: null,
    boundingBox: null,
    provider: "gemini",
    providerModel: "gemini-2.5-flash",
    origin: "provider",
    extractedAt: NOW,
    reviewedBy: null,
    reviewedAt: null,
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

function parcel(overrides: Partial<BackendParcel> = {}): BackendParcel {
  return {
    id: PARCEL,
    ownerId: null,
    origin: "user_created",
    lifecycle: "active",
    survey: "BS",
    khatianNumber: "120",
    mouza: "চর গোপালপুর",
    jlNumber: "17",
    upazila: "মিরপুর",
    district: "কুষ্টিয়া",
    areaDecimal: "1.2500",
    shareNumerator: 1,
    shareDenominator: 3,
    ownershipShare: "1/3",
    dagNumbers: ["456", "457"],
    version: 1,
    retirementReason: null,
    retiredAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

function page<T>(items: T[]) {
  return { items, total: items.length, limit: 50, offset: 0, hasMore: false }
}

/** A canned reply whose status may be overridden, for failure paths. */
interface Canned {
  __status: number
  __body: unknown
}

function canned(status: number, body: unknown): Canned {
  return { __status: status, __body: body }
}

function isCanned(value: unknown): value is Canned {
  return typeof value === "object" && value !== null && "__status" in value
}

/**
 * Replies with canned bodies keyed by `"METHOD url"` (or by plain url for GETs),
 * and records everything the page asked for. An array value is consumed one
 * entry per call, repeating its last entry: that is how a job progressing from
 * `queued` to `completed` is modelled without any real wait.
 */
function mockApi(routes: Record<string, unknown>) {
  const originalFetch = globalThis.fetch
  const calls: string[] = []
  const requests: { method: string; url: string; body: unknown }[] = []
  const seen = new Map<string, number>()

  globalThis.fetch = async (input, init) => {
    const url = String(input)
    const method = (init?.method ?? "GET").toUpperCase()
    const body =
      typeof init?.body === "string" ? JSON.parse(init.body) : null
    calls.push(url)
    requests.push({ method, url, body })

    const key = `${method} ${url}`
    const route = routes[key] ?? routes[url]
    if (route === undefined) {
      return new Response(
        JSON.stringify({
          error: { code: "not_found", message: "no mock route" },
        }),
        { status: 404, headers: { "content-type": "application/json" } },
      )
    }

    const index = seen.get(key) ?? 0
    seen.set(key, index + 1)
    const value = Array.isArray(route)
      ? route[Math.min(index, route.length - 1)]
      : route

    const reply = isCanned(value) ? value : { __status: 200, __body: value }
    return new Response(JSON.stringify(reply.__body), {
      status: reply.__status,
      headers: { "content-type": "application/json" },
    })
  }

  return {
    calls,
    requests,
    sent: () => requests.map((request) => `${request.method} ${request.url}`),
    restore: () => {
      globalThis.fetch = originalFetch
    },
  }
}

test("Job matching: newest finished extraction job for the exact document", () => {
  const otherDocument = job({ id: "job-other", sourceDocumentId: DOC_B })
  const failed = job({
    id: "job-failed",
    status: "failed",
    result: null,
    lastError: "provider refused",
  })
  const stillRunning = job({ id: "job-running", status: "processing" })
  const queued = job({ id: "job-queued", status: "queued" })
  const otherKind = job({ id: "job-recon", kind: "parcel_reconciliation" })
  const finished = job({
    id: "job-finished",
    result: { extractionIds: ["ext-1"] },
  })
  const older = job({ id: "job-older", result: { extractionIds: ["ext-0"] } })

  // The list is ordered newest first by the API.
  const jobs = [
    otherDocument,
    failed,
    stillRunning,
    queued,
    otherKind,
    finished,
    older,
  ]

  assert.strictEqual(findDocumentExtractionJob(jobs, DOC_A)?.id, "job-finished")
  // A document whose only job failed has no reading at all.
  assert.strictEqual(findDocumentExtractionJob([failed, queued], DOC_A), null)
  assert.strictEqual(findDocumentExtractionJob(jobs, "unknown-doc"), null)
})

test("Job matching: the newest attempt is reported even when it is not a reading", () => {
  const failed = job({ id: "job-failed", status: "failed", result: null })
  const finished = job({
    id: "job-finished",
    result: { extractionIds: ["ext-1"] },
  })

  // A newer failure must not be hidden behind an older success: the page has to
  // be able to say that the last attempt did not work.
  assert.strictEqual(findLatestDocumentExtractionJob([failed, finished], DOC_A)?.id, "job-failed")
  assert.strictEqual(findDocumentExtractionJob([failed, finished], DOC_A)?.id, "job-finished")
  // Another document's job is not this document's newest attempt.
  assert.strictEqual(
    findLatestDocumentExtractionJob([job({ sourceDocumentId: DOC_B })], DOC_A),
    null,
  )
})

test("Job states: running is not terminal, and no terminal state is running", () => {
  assert.strictEqual(isRunningJob("queued"), true)
  assert.strictEqual(isRunningJob("processing"), true)
  assert.strictEqual(isRunningJob("retry_pending"), true)
  for (const status of ["completed", "review_required", "failed", "cancelled"] as const) {
    assert.strictEqual(isRunningJob(status), false)
    assert.strictEqual(isTerminalJobStatus(status), true)
  }
})

test("Job matching: review_required counts as finished, a missing result never does", () => {
  const reviewRequired = job({
    id: "job-review",
    status: "review_required",
    result: { extractionIds: ["ext-1"] },
  })
  assert.strictEqual(findDocumentExtractionJob([reviewRequired], DOC_A)?.id, "job-review")

  // `completed` with no stored result is not a reading.
  const completedWithoutResult = job({ id: "job-empty", result: null })
  assert.strictEqual(findDocumentExtractionJob([completedWithoutResult], DOC_A), null)
})

test("Extraction ids: absent and present-but-empty are different answers", () => {
  assert.strictEqual(readExtractionIds(null), null)
  assert.strictEqual(readExtractionIds({}), null)
  assert.strictEqual(readExtractionIds({ extractionIds: "ext-1" }), null)
  assert.deepStrictEqual(readExtractionIds({ extractionIds: [] }), [])
  assert.deepStrictEqual(
    readExtractionIds({ extractionIds: ["ext-1", 7, null, "ext-2"] }),
    ["ext-1", "ext-2"],
  )
})

test("Filtering: another document's reading and a manual entry are both excluded", () => {
  const mine = extraction({ id: "ext-mine", field: "khatian" })
  const otherDocument = extraction({
    id: "ext-other-doc",
    sourceDocumentId: DOC_B,
  })
  const handTyped = extraction({
    id: "ext-manual",
    sourceDocumentId: null,
    origin: "manual_entry",
    provider: null,
    providerModel: null,
  })
  const previousRun = extraction({ id: "ext-previous-run", field: "mouza" })

  // The job listed its own rows, so an earlier reading of the same document is
  // not mixed in.
  const withJobIds = selectDocumentExtractions(
    [mine, otherDocument, handTyped, previousRun],
    { documentId: DOC_A, extractionIds: ["ext-mine"] },
  )
  assert.deepStrictEqual(
    withJobIds.map((row) => row.id),
    ["ext-mine"],
  )

  // A job that recorded no id list falls back to the document match alone, and
  // still refuses the manual entry and the other document.
  const withoutJobIds = selectDocumentExtractions(
    [mine, otherDocument, handTyped, previousRun],
    { documentId: DOC_A, extractionIds: null },
  )
  assert.deepStrictEqual(
    withoutJobIds.map((row) => row.id),
    ["ext-mine", "ext-previous-run"],
  )
})

test("Filtering: a job that read nothing keeps nothing", () => {
  const rows = [extraction({ id: "ext-mine" })]
  assert.deepStrictEqual(
    selectDocumentExtractions(rows, { documentId: DOC_A, extractionIds: [] }),
    [],
  )
})

test("Ordering: the six fields, in the order a record is read", () => {
  const rows = [
    extraction({ id: "e6", field: "owner" }),
    extraction({ id: "e3", field: "dag" }),
    extraction({ id: "e1", field: "khatian" }),
    extraction({ id: "e5", field: "share" }),
    extraction({ id: "e2", field: "mouza" }),
    extraction({ id: "e4", field: "area" }),
  ]
  assert.deepStrictEqual(
    orderReadings(rows).map((row) => row.field),
    EXTRACTION_FIELD_ORDER,
  )
})

/** The six rows a successful Gemini read of one document leaves behind. */
const RECORDED: [ExtractionField, string][] = [
  ["khatian", "১২০/ক"],
  ["mouza", "চর গোপালপুর"],
  ["dag", "৪৫৬"],
  ["area", "১.২৫ একর"],
  ["share", "১/৩"],
  ["owner", "রহিমা বেগম"],
]

function sixStoredRows() {
  return RECORDED.map(([field, recordedValue], index) =>
    extraction({
      id: `ext-${field}`,
      field,
      recordedValue,
      confidence: index === 0 ? "0.93" : null,
      pageReference: index === 0 ? "1" : null,
    }),
  )
}

test("Loading: the six stored fields are shown for their own document", async () => {
  const stored = sixStoredRows()
  const api = mockApi({
    "/api/v1/jobs?kind=document_extraction&limit=50": page([
      job({
        result: {
          provider: "gemini",
          model: "gemini-2.5-flash",
          readsDocumentContent: true,
          extractionIds: stored.map((row) => row.id),
        },
      }),
    ]),
    [`/api/v1/parcels/${PARCEL}/extractions`]: page(stored),
  })

  try {
    const lookup = await fetchDocumentExtraction(DOC_A)

    // The two documented endpoints, and nothing else.
    assert.deepStrictEqual(api.calls, [
      "/api/v1/jobs?kind=document_extraction&limit=50",
      `/api/v1/parcels/${PARCEL}/extractions`,
    ])

    const reading = lookup.extraction
    assert.notStrictEqual(reading, null)
    assert.strictEqual(lookup.job?.status, "completed")
    assert.strictEqual(reading?.jobId, JOB_A)
    assert.deepStrictEqual(
      reading?.readings.map((row) => row.field),
      EXTRACTION_FIELD_ORDER,
    )
    assert.deepStrictEqual(
      reading?.readings.map((row) => row.recordedValue),
      RECORDED.map(([, value]) => value),
    )
    // The provider and the model are the ones the job actually reported.
    assert.strictEqual(reading?.provider, "gemini")
    assert.strictEqual(reading?.providerModel, "gemini-2.5-flash")
    assert.strictEqual(reading?.readsDocumentContent, true)
    assert.strictEqual(reading?.needsHumanReview, false)
    // Confidence and page reference only when the rows actually carry them.
    assert.strictEqual(reading?.readings[0]?.confidence, "0.93")
    assert.strictEqual(reading?.readings[1]?.confidence, null)
    assert.strictEqual(reading?.readings[1]?.pageReference, null)
  } finally {
    api.restore()
  }
})

test("Loading: a row for another document is dropped even when the job lists no ids", async () => {
  const mine = extraction({ id: "ext-mine", field: "khatian", recordedValue: "১২০/ক" })
  const other = extraction({
    id: "ext-other",
    sourceDocumentId: DOC_B,
    field: "khatian",
    recordedValue: "৯৯৯",
  })
  const api = mockApi({
    "/api/v1/jobs?kind=document_extraction&limit=50": page([
      job({
        result: {
          provider: "gemini",
          model: "gemini-2.5-flash",
          readsDocumentContent: true,
        },
      }),
    ]),
    [`/api/v1/parcels/${PARCEL}/extractions`]: page([mine, other]),
  })

  try {
    const lookup = await fetchDocumentExtraction(DOC_A)
    assert.deepStrictEqual(
      lookup.extraction?.readings.map((row) => row.recordedValue),
      ["১২০/ক"],
    )
  } finally {
    api.restore()
  }
})

test("Loading: a document nobody has read is not an error, and starts no work", async () => {
  const api = mockApi({
    "/api/v1/jobs?kind=document_extraction&limit=50": page([
      job({ id: "job-other", sourceDocumentId: DOC_B }),
    ]),
  })

  try {
    assert.deepStrictEqual(await fetchDocumentExtraction(DOC_A), {
      job: null,
      extraction: null,
    })
    // Reading the page never queues anything.
    assert.deepStrictEqual(api.sent(), [
      "GET /api/v1/jobs?kind=document_extraction&limit=50",
    ])
  } finally {
    api.restore()
  }
})

test("Loading: a running job is reported as running, with no reading and no extra request", async () => {
  const api = mockApi({
    "/api/v1/jobs?kind=document_extraction&limit=50": page([
      job({ id: "job-running", status: "processing" }),
      job({ id: "job-other", sourceDocumentId: DOC_B }),
    ]),
  })

  try {
    const lookup = await fetchDocumentExtraction(DOC_A)
    assert.strictEqual(lookup.job?.status, "processing")
    assert.strictEqual(lookup.extraction, null)
    assert.deepStrictEqual(api.calls, [
      "/api/v1/jobs?kind=document_extraction&limit=50",
    ])
  } finally {
    api.restore()
  }
})

test("Loading: a newer failed attempt is reported beside the stored reading", async () => {
  const stored = sixStoredRows()
  const api = mockApi({
    "/api/v1/jobs?kind=document_extraction&limit=50": page([
      job({
        id: "job-failed",
        status: "failed",
        result: null,
        lastError: "provider_error: quota exhausted",
      }),
      job({
        result: { provider: "gemini", model: "gemini-2.5-flash", extractionIds: ["ext-owner"] },
      }),
    ]),
    [`/api/v1/parcels/${PARCEL}/extractions`]: page(stored),
  })

  try {
    const lookup = await fetchDocumentExtraction(DOC_A)
    // The reading is still the earlier one, and the newest attempt is a failure
    // the page can see (`job.id !== extraction.jobId`).
    assert.strictEqual(lookup.job?.status, "failed")
    assert.strictEqual(lookup.job?.lastError, "provider_error: quota exhausted")
    assert.strictEqual(lookup.extraction?.readings.length, 1)
    assert.notStrictEqual(lookup.job?.id, lookup.extraction?.jobId)
  } finally {
    api.restore()
  }
})

test("Loading: a job that read nothing yields no readings", async () => {
  const api = mockApi({
    "/api/v1/jobs?kind=document_extraction&limit=50": page([
      job({
        result: {
          provider: "gemini",
          model: "gemini-2.5-flash",
          readsDocumentContent: true,
          extractionIds: [],
        },
      }),
    ]),
    [`/api/v1/parcels/${PARCEL}/extractions`]: page([]),
  })

  try {
    const lookup = await fetchDocumentExtraction(DOC_A)
    assert.deepStrictEqual(lookup.extraction?.readings, [])
  } finally {
    api.restore()
  }
})

test("Loading: unclear readings ask for a person, and a correction is kept apart", async () => {
  const stored = [
    extraction({
      id: "ext-area",
      field: "area",
      recordedValue: "১.২৫ একর",
      isUnclear: true,
      reviewStatus: "unclear",
    }),
    extraction({
      id: "ext-owner",
      field: "owner",
      recordedValue: "রহিমা বেগ",
      reviewedValue: "রহিমা বেগম",
      reviewStatus: "corrected",
    }),
  ]
  const api = mockApi({
    "/api/v1/jobs?kind=document_extraction&limit=50": page([
      job({
        status: "review_required",
        result: {
          provider: "gemini",
          model: "gemini-2.5-flash",
          readsDocumentContent: true,
          extractionIds: stored.map((row) => row.id),
        },
      }),
    ]),
    [`/api/v1/parcels/${PARCEL}/extractions`]: page(stored),
  })

  try {
    const lookup = await fetchDocumentExtraction(DOC_A)
    assert.strictEqual(lookup.extraction?.needsHumanReview, true)
    // What the model read and what a person decided are both kept.
    const owner = lookup.extraction?.readings.find((row) => row.field === "owner")
    assert.strictEqual(owner?.recordedValue, "রহিমা বেগ")
    assert.strictEqual(owner?.reviewedValue, "রহিমা বেগম")
    assert.strictEqual(owner?.reviewStatus, "corrected")
    const area = lookup.extraction?.readings.find((row) => row.field === "area")
    assert.strictEqual(area?.reviewedValue, null)
    assert.strictEqual(area?.isUnclear, true)
  } finally {
    api.restore()
  }
})

test("Loading: an unreadable reading counts as needing a person even on a completed job", async () => {
  const stored = [
    extraction({ id: "ext-dag", field: "dag", isUnclear: true, reviewStatus: "unclear" }),
  ]
  const api = mockApi({
    "/api/v1/jobs?kind=document_extraction&limit=50": page([
      job({
        result: {
          provider: "gemini",
          model: "gemini-2.5-flash",
          readsDocumentContent: true,
          extractionIds: ["ext-dag"],
        },
      }),
    ]),
    [`/api/v1/parcels/${PARCEL}/extractions`]: page(stored),
  })

  try {
    const lookup = await fetchDocumentExtraction(DOC_A)
    assert.strictEqual(lookup.extraction?.needsHumanReview, true)
  } finally {
    api.restore()
  }
})

test("Loading: a synthetic provider's fixtures are marked as not read from the document", async () => {
  const stored = sixStoredRows()
  const api = mockApi({
    "/api/v1/jobs?kind=document_extraction&limit=50": page([
      job({
        result: {
          provider: "mock",
          model: "mock-double",
          readsDocumentContent: false,
          extractionIds: stored.map((row) => row.id),
        },
      }),
    ]),
    [`/api/v1/parcels/${PARCEL}/extractions`]: page(stored),
  })

  try {
    const lookup = await fetchDocumentExtraction(DOC_A)
    // The rows exist, but the job itself says the document was never read, so
    // the page must refuse to show them as a reading.
    assert.strictEqual(lookup.extraction?.readsDocumentContent, false)
  } finally {
    api.restore()
  }
})

test("Loading: the demo session never calls the API", async () => {
  const api = mockApi({})
  try {
    startDemo("citizen")
    assert.deepStrictEqual(await fetchDocumentExtraction(DOC_A), {
      job: null,
      extraction: null,
    })
    assert.deepStrictEqual(api.calls, [])
  } finally {
    setSession(null)
    api.restore()
  }
})

test("Queueing: one document_extraction for the chosen parcel, and nothing else", async () => {
  const api = mockApi({
    "POST /api/v1/jobs": canned(202, job({ status: "queued" })),
  })

  try {
    const queued = await enqueueDocumentExtraction({ documentId: DOC_A, parcelId: PARCEL })

    assert.deepStrictEqual(api.sent(), ["POST /api/v1/jobs"])
    assert.deepStrictEqual(api.requests[0]?.body, {
      kind: "document_extraction",
      parcelId: PARCEL,
      sourceDocumentId: DOC_A,
    })
    assert.strictEqual(summariseJob(queued).status, "queued")
  } finally {
    api.restore()
  }
})

test("Queueing: the job summary carries the state and never the payload", () => {
  const summary = summariseJob(
    job({
      payload: { apiKey: "secret" },
      result: { provider: "gemini", extractionIds: ["ext-1"] },
      lastError: null,
    }),
  )
  assert.deepStrictEqual(summary, {
    id: JOB_A,
    status: "completed",
    lastError: null,
  })
  assert.deepStrictEqual(Object.keys(summary).sort(), ["id", "lastError", "status"])
})

test("Queue and poll: queued to completed, followed through the job's own endpoint", async () => {
  const api = mockApi({
    "POST /api/v1/jobs": job({ status: "queued" }),
    [`GET /api/v1/jobs/${JOB_A}`]: [
      job({ status: "processing" }),
      job({
        status: "completed",
        result: { provider: "gemini", extractionIds: ["ext-1"] },
      }),
    ],
  })

  try {
    const queued = await enqueueDocumentExtraction({ documentId: DOC_A, parcelId: PARCEL })
    assert.strictEqual(queued.status, "queued")

    const seen: string[] = []
    const final = await pollDocumentExtractionJob(
      queued.id,
      (progress) => seen.push(progress.status),
      { intervalMs: 0, maxAttempts: 10 },
    )

    assert.deepStrictEqual(seen, ["processing", "completed"])
    assert.deepStrictEqual(api.sent(), [
      "POST /api/v1/jobs",
      `GET /api/v1/jobs/${JOB_A}`,
      `GET /api/v1/jobs/${JOB_A}`,
    ])
    assert.strictEqual(final.status, "completed")
    assert.strictEqual(isTerminalJobStatus(final.status), true)
  } finally {
    api.restore()
  }
})

test("Queue and poll: a failed job is reported as failed, never as success", async () => {
  const api = mockApi({
    "POST /api/v1/jobs": job({ status: "queued" }),
    [`GET /api/v1/jobs/${JOB_A}`]: job({
      status: "failed",
      result: null,
      lastError: "provider_error: could not read the document",
    }),
  })

  try {
    const queued = await enqueueDocumentExtraction({ documentId: DOC_A, parcelId: PARCEL })
    const final = await pollDocumentExtractionJob(queued.id, undefined, {
      intervalMs: 0,
      maxAttempts: 5,
    })

    assert.strictEqual(final.status, "failed")
    assert.strictEqual(final.lastError, "provider_error: could not read the document")
    assert.strictEqual(isTerminalJobStatus(final.status), true)
  } finally {
    api.restore()
  }
})

test("Polling: a job that has not settled is reported as still running, not as finished", async () => {
  const api = mockApi({
    [`GET /api/v1/jobs/${JOB_A}`]: job({ status: "processing" }),
  })

  try {
    const final = await pollDocumentExtractionJob(JOB_A, undefined, {
      intervalMs: 0,
      maxAttempts: 2,
    })
    // The initial read plus two attempts, then it stops asking.
    assert.deepStrictEqual(api.sent(), [
      `GET /api/v1/jobs/${JOB_A}`,
      `GET /api/v1/jobs/${JOB_A}`,
      `GET /api/v1/jobs/${JOB_A}`,
    ])
    assert.strictEqual(final.status, "processing")
    assert.strictEqual(isRunningJob(final.status), true)
  } finally {
    api.restore()
  }
})

test("Polling: a status read that fails is thrown, not hidden", async () => {
  const api = mockApi({
    [`GET /api/v1/jobs/${JOB_A}`]: canned(500, {
      error: { code: "internal_error", message: "boom" },
    }),
  })

  try {
    await assert.rejects(() =>
      pollDocumentExtractionJob(JOB_A, undefined, { intervalMs: 0, maxAttempts: 3 }),
    )
  } finally {
    api.restore()
  }
})

test("Polling: one job's state can be read on its own", async () => {
  const api = mockApi({
    [`GET /api/v1/jobs/${JOB_A}`]: job({ status: "retry_pending", lastError: "timeout" }),
  })

  try {
    const summary = await fetchJob(JOB_A)
    assert.deepStrictEqual(summary, {
      id: JOB_A,
      status: "retry_pending",
      lastError: "timeout",
    })
    assert.deepStrictEqual(api.sent(), [`GET /api/v1/jobs/${JOB_A}`])
  } finally {
    api.restore()
  }
})

test("Parcels: only the records the caller can see are offered, and no id is invented", async () => {
  const api = mockApi({
    "/api/v1/parcels?limit=50": page([
      parcel({ id: PARCEL, khatianNumber: "120", dagNumbers: ["456", "457"] }),
      parcel({ id: "55555555-5555-4555-8555-555555555555", dagNumbers: [] }),
    ]),
  })

  try {
    const options = await fetchSelectableParcels()
    assert.deepStrictEqual(api.sent(), ["GET /api/v1/parcels?limit=50"])
    assert.deepStrictEqual(options, [
      {
        id: PARCEL,
        khatianNumber: "120",
        mouza: "চর গোপালপুর",
        dagNumbers: ["456", "457"],
        upazila: "মিরপুর",
        district: "কুষ্টিয়া",
      },
      {
        id: "55555555-5555-4555-8555-555555555555",
        khatianNumber: "120",
        mouza: "চর গোপালপুর",
        dagNumbers: [],
        upazila: "মিরপুর",
        district: "কুষ্টিয়া",
      },
    ])
  } finally {
    api.restore()
  }
})

test("Error copy: a session change and a dead connection read differently, and neither claims a reading", () => {
  const changed = describeDocumentExtractionError(new ApiError("unauthorised", 401))
  const dead = describeDocumentExtractionError(
    new ApiError("offline", 0, "network_error"),
  )
  const unknown = describeDocumentExtractionError(new Error("boom"))

  for (const message of [changed, dead, unknown]) {
    assert.ok(message.length > 0)
  }
  assert.notStrictEqual(changed, dead)
  // The copy is about failing to fetch, so it never asserts a value was read.
  assert.match(changed, /সাইন ইন/)
  assert.match(dead, /সংযোগ/)
})

test("Error copy: a refused queue request says so and never implies a reading started", () => {
  const forbidden = describeExtractionQueueError(new ApiError("forbidden", 403))
  const gone = describeExtractionQueueError(new ApiError("missing", 404))
  const dead = describeExtractionQueueError(new ApiError("offline", 0, "network_error"))
  const unknown = describeExtractionQueueError(new Error("boom"))

  assert.match(forbidden, /অনুমতি/)
  assert.notStrictEqual(forbidden, gone)
  assert.notStrictEqual(gone, dead)
  for (const message of [forbidden, gone, dead, unknown]) {
    assert.ok(message.length > 0)
    assert.doesNotMatch(message, /সফল/)
  }
})
