import { ApiError, apiGet, apiPost } from "./client"
import { isDemoMode } from "./session"
import type {
  BackendApplication,
  Finding,
  Page,
  ReconciliationResult,
  ReviewCaseSummary,
  ReviewFindingInput,
  ReviewFindingResult,
  ReviewOutcomeInput,
  ReviewOutcomeResult,
  ReviewQueue,
} from "./types"
import { applicationTypeLabel } from "@/lib/domain"
import {
  mockFetchAllFindings,
  mockFetchFindingsForParcel,
  mockFetchReconciliation,
  mockFetchReviewCases,
  mockRecordReviewOutcome,
  mockReviewFinding,
} from "@/mocks/service"

/**
 * Loads review cases for the reviewer work desk.
 *
 * In live mode: queries real applications from the backend (`GET /api/v1/applications`)
 * and maps active filings into review cases.
 * In demo mode: returns simulated synthetic demo cases.
 */
export async function fetchReviewCases(
  signal?: AbortSignal,
): Promise<ReviewCaseSummary[]> {
  if (isDemoMode()) {
    return mockFetchReviewCases(signal)
  }

  const page = await apiGet<Page<BackendApplication>>(
    "/api/v1/applications?limit=50",
    signal,
  )
  if (!page?.items?.length) {
    return []
  }

  return page.items.map((app) => ({
    id: app.id,
    reference: app.trackingNumber || app.id.slice(0, 8),
    title: `${applicationTypeLabel[app.type]} — ${app.mouza} মৌজা`,
    summary: `খতিয়ান ${app.khatianNumber}, দাগ ${app.dagNumber} (${app.district}, ${app.upazila})`,
    status:
      app.status === "submitted"
        ? "new"
        : app.status === "under_review"
          ? "in_progress"
          : "needs_info",
    receivedAt: app.submittedAt || app.createdAt,
    nextAction:
      app.nextStep ||
      (app.status === "submitted" ? "প্রাথমিক যাচাই" : "নথি পর্যালোচনা"),
    parcelId: app.parcelId || undefined,
  }))
}

/**
 * Loads the full reviewer work queue from GET /api/v1/review/queue.
 */
export async function fetchReviewQueue(
  signal?: AbortSignal,
): Promise<ReviewQueue> {
  if (isDemoMode()) {
    const findings = await mockFetchAllFindings(signal)
    return {
      pendingExtractions: [],
      openFindings: findings,
      totals: {
        pendingExtractions: 0,
        openFindings: findings.length,
      },
    }
  }

  return apiGet<ReviewQueue>("/api/v1/review/queue", signal)
}

/**
 * Loads open discrepancy findings awaiting review.
 */
export async function fetchAllFindings(
  signal?: AbortSignal,
): Promise<Finding[]> {
  if (isDemoMode()) {
    return mockFetchAllFindings(signal)
  }

  const queue = await apiGet<ReviewQueue>("/api/v1/review/queue", signal)
  return queue.openFindings ?? []
}

/**
 * Loads findings associated with a specific parcel.
 */
export async function fetchParcelFindings(
  parcelId: string,
  signal?: AbortSignal,
): Promise<Finding[]> {
  if (isDemoMode()) {
    return mockFetchFindingsForParcel(parcelId, signal)
  }

  const res = await apiGet<{ items: Finding[] }>(
    `/api/v1/parcels/${encodeURIComponent(parcelId)}/findings`,
    signal,
  )
  return res.items ?? []
}

/**
 * Loads reconciliation and deterministic readiness rules evaluation for a parcel.
 */
export async function fetchParcelReconciliation(
  parcelId: string,
  signal?: AbortSignal,
): Promise<ReconciliationResult | null> {
  if (isDemoMode()) {
    return mockFetchReconciliation(parcelId, signal)
  }

  return apiGet<ReconciliationResult>(
    `/api/v1/parcels/${encodeURIComponent(parcelId)}/reconciliation`,
    signal,
  )
}

/**
 * Records a reviewer decision on a finding (under_review, resolved, or dismissed).
 * Sends optimistic concurrency version token.
 */
export async function recordFindingReview(
  input: ReviewFindingInput,
): Promise<ReviewFindingResult> {
  if (isDemoMode()) {
    return mockReviewFinding(input)
  }

  return apiPost<ReviewFindingResult>(
    `/api/v1/findings/${encodeURIComponent(input.findingId)}/review`,
    {
      action: input.action,
      reason: input.reason,
      version: input.version,
    },
  )
}

/**
 * Records a reviewer decision on an extracted field value.
 *
 * The interactive extraction-review desk is a prototype driven by synthetic
 * fixtures, so it holds neither the real extraction UUID nor the server's
 * current version token. Posting a fixture identifier and a guessed version to
 * the live endpoint would fail obscurely at best and misrepresent a mock
 * decision as a recorded one at worst, so this refuses outright in live mode.
 *
 * The endpoint a future, real integration must target is
 * `POST /api/v1/extractions/:extractionId/review`, which takes a UUID
 * `extractionId`, the server-issued `version`, and an `outcome` of `verified`,
 * `correction`, or `needs_review` (`dismissed` is not part of that vocabulary).
 */
export async function recordReviewOutcome(
  input: ReviewOutcomeInput,
): Promise<ReviewOutcomeResult> {
  if (isDemoMode()) {
    return mockRecordReviewOutcome(input)
  }

  throw new ApiError(
    "এই সংস্করণে সরাসরি নথি-যাচাই সিদ্ধান্ত জমা দেওয়া সমর্থিত নয়। পর্যালোচনার কার্যতালিকা ব্যবহার করুন।",
    501,
    "extraction_review_not_implemented",
  )
}
