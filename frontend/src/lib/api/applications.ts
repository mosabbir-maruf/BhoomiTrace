import { apiGet, apiPatch, apiPost } from "./client"
import { isDemoMode } from "./session"
import type {
  ApplicationStatus,
  ApplicationType,
  BackendApplication,
  NewApplicationDraft,
  NewApplicationResult,
  Page,
} from "./types"
import { toAsciiDigits } from "@/lib/format"
import { mockSubmitApplication } from "@/mocks/service"

const ALLOWED_DOC_CODES = new Set(["deed", "id", "khatian", "tax", "heir"])

/**
 * Submits a new citizen application.
 *
 * In live mode (connected to the BhoomiTrace Fastify backend):
 * 1. Creates a draft application via POST /api/v1/applications
 * 2. Immediately transitions the draft to "submitted" via POST /api/v1/applications/:id/transitions,
 *    assigning an official sequence tracking number (e.g. APP-2026-000001)
 *
 * In demo mode (unauthenticated or explicit client-side demo):
 * Returns a simulated submission reference without touching backend state.
 */
export async function submitApplication(
  draft: NewApplicationDraft,
): Promise<NewApplicationResult> {
  if (isDemoMode()) {
    return mockSubmitApplication(draft)
  }

  // Format and validate payload strictly matching backend schemas
  const payload: Record<string, unknown> = {
    type: draft.type,
    district: draft.district.trim(),
    upazila: draft.upazila.trim(),
    mouza: draft.mouza.trim(),
    khatianNumber: toAsciiDigits(draft.khatianNumber.trim()),
    dagNumber: toAsciiDigits(draft.dagNumber.trim()),
    documents: draft.documents.filter((code) => ALLOWED_DOC_CODES.has(code)),
  }

  if (draft.areaDecimal && draft.areaDecimal.trim()) {
    const normArea = toAsciiDigits(draft.areaDecimal.trim()).replace(
      /[।,\s]/g,
      ".",
    )
    if (/^\d+(\.\d{1,4})?$/.test(normArea)) {
      payload.areaDecimal = normArea
    }
  }

  if (draft.share && draft.share.trim()) {
    const normShare = toAsciiDigits(draft.share.trim()).replace(/[।\s]/g, "")
    if (/^\d+(\s*\/\s*\d+)?$/.test(normShare)) {
      payload.share = normShare
    }
  }

  if (draft.parcelId) {
    payload.parcelId = draft.parcelId
  }

  // Step 1: Create the draft application
  const created = await apiPost<BackendApplication>(
    "/api/v1/applications",
    payload,
  )

  // Step 2: Transition the draft to "submitted"
  const submitted = await apiPost<BackendApplication>(
    `/api/v1/applications/${created.id}/transitions`,
    {
      version: created.version,
      toStatus: "submitted",
    },
  )

  return {
    referenceId: submitted.trackingNumber || submitted.id,
    demo: false,
    applicationId: submitted.id,
    trackingNumber: submitted.trackingNumber,
  }
}

/**
 * Lists applications visible to the current caller.
 * Applicants see their own; reviewers/administrators see all applications.
 */
export async function fetchApplications(
  filters?: {
    status?: ApplicationStatus
    type?: ApplicationType
    parcelId?: string
    page?: number
    limit?: number
  },
  signal?: AbortSignal,
): Promise<Page<BackendApplication>> {
  const params = new URLSearchParams()
  if (filters?.status) params.set("status", filters.status)
  if (filters?.type) params.set("type", filters.type)
  if (filters?.parcelId) params.set("parcelId", filters.parcelId)
  if (filters?.page) params.set("page", String(filters.page))
  if (filters?.limit) params.set("limit", String(filters.limit))
  const qs = params.toString()
  return apiGet<Page<BackendApplication>>(
    `/api/v1/applications${qs ? `?${qs}` : ""}`,
    signal,
  )
}

/**
 * Transitions an application to its next state in the workflow.
 * Requires the current version token for optimistic concurrency control.
 */
export async function transitionApplication(
  id: string,
  payload: {
    version: number
    toStatus: ApplicationStatus
    note?: string
    nextStep?: string
    deadline?: string | null
  },
): Promise<BackendApplication> {
  return apiPost<BackendApplication>(
    `/api/v1/applications/${id}/transitions`,
    payload,
  )
}

/**
 * Updates draft application details.
 */
export async function updateApplication(
  id: string,
  payload: {
    version: number
    district?: string
    upazila?: string
    mouza?: string
    khatianNumber?: string
    dagNumber?: string
    areaDecimal?: string | null
    share?: string | null
    documents?: string[]
    parcelId?: string | null
  },
): Promise<BackendApplication> {
  return apiPatch<BackendApplication>(`/api/v1/applications/${id}`, payload)
}
