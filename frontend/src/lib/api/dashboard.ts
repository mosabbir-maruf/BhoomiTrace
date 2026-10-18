import { apiGet, apiPost } from "./client"
import { isCurrentSessionDemo } from "./session"
import type {
  ActionItem,
  ApplicantDashboard,
  ApplicantProfile,
  ApplicationDetail,
  ApplicationSummary,
  BackendApplication,
  BackendApplicationDetail,
  BackendDocument,
  BackendParcel,
  CertifiedCopyRequestResult,
  DocumentItem,
  Finding,
  LineageList,
  Page,
  Parcel,
  ParcelDetail,
  ParcelHistoryEntry,
  PublicUser,
  ReconciliationResult,
} from "./types"
import {
  mockFetchApplicantDashboard,
  mockFetchApplication,
  mockFetchDocument,
  mockFetchParcel,
  mockRequestCertifiedCopy,
} from "@/mocks/service"

/**
 * Maps a backend parcel (where areaDecimal is an exact string) to the frontend Parcel model.
 */
function toFrontendParcel(p: BackendParcel): Parcel {
  return {
    ...p,
    areaDecimal:
      typeof p.areaDecimal === "string"
        ? parseFloat(p.areaDecimal)
        : p.areaDecimal,
    rawAreaDecimal: p.areaDecimal,
  }
}

/**
 * Maps a backend application to an ApplicationSummary.
 */
function toApplicationSummary(a: BackendApplication): ApplicationSummary {
  return {
    id: a.id,
    trackingNumber: a.trackingNumber,
    type: a.type,
    district: a.district,
    upazila: a.upazila,
    mouza: a.mouza,
    khatianNumber: a.khatianNumber,
    dagNumber: a.dagNumber,
    parcelId: a.parcelId,
    submittedAt: a.submittedAt,
    updatedAt: a.updatedAt,
    status: a.status,
    nextStep: a.nextStep,
    deadline: a.deadline,
    version: a.version,
  }
}

/**
 * Maps a backend document to a frontend DocumentItem.
 */
function toDocumentItem(
  d: BackendDocument,
  applicationId?: string | null,
  parcelId?: string | null,
): DocumentItem {
  return {
    id: d.id,
    name: d.title,
    applicationId: applicationId ?? null,
    parcelId: parcelId ?? null,
    status: d.status,
    date: d.createdAt,
    reference: d.reference,
    pages: d.pageCount,
    note: d.origin === "synthetic_demo" ? "নমুনা নথি" : "ব্যবহারকারী জমাকৃত নথি",
    fields: [],
    hasStoredFile: d.hasStoredFile,
    contentType: d.contentType,
    byteSize: d.byteSize,
    originalFilename: d.originalFilename,
  }
}

/**
 * Loads the applicant dashboard by composing real Fastify API endpoints:
 * - GET /api/v1/auth/me
 * - GET /api/v1/parcels
 * - GET /api/v1/applications
 * - GET /api/v1/documents
 */
export async function fetchApplicantDashboard(
  signal?: AbortSignal,
): Promise<ApplicantDashboard> {
  if (isCurrentSessionDemo()) {
    return mockFetchApplicantDashboard(signal)
  }

  const [me, parcelsPage, applicationsPage, documentsPage] = await Promise.all([
    apiGet<PublicUser>("/api/v1/auth/me", signal).catch(() => null),
    apiGet<Page<BackendParcel>>("/api/v1/parcels?limit=50", signal),
    apiGet<Page<BackendApplication>>("/api/v1/applications?limit=50", signal),
    apiGet<Page<BackendDocument>>("/api/v1/documents?limit=50", signal).catch(
      () => ({
        items: [] as BackendDocument[],
        total: 0,
        limit: 50,
        offset: 0,
        hasMore: false,
      }),
    ),
  ])

  const today = new Date().toISOString().slice(0, 10)
  const parcels = parcelsPage.items.map(toFrontendParcel)
  const applications = applicationsPage.items.map(toApplicationSummary)
  const documents = documentsPage.items.map((d) => toDocumentItem(d))

  // Derive action items from applications needing attention
  const actionItems: ActionItem[] = []
  for (const app of applications) {
    if (app.status === "documents_required") {
      actionItems.push({
        id: `act-${app.id}-doc`,
        kind: "document",
        title: "অতিরিক্ত নথি জমা দিন",
        detail: app.nextStep || "আবেদন এগিয়ে নিতে চাওয়া কাগজপত্র জমা দিন।",
        dueDate: app.deadline || today,
        applicationId: app.id,
      })
    } else if (app.status === "hearing_scheduled") {
      actionItems.push({
        id: `act-${app.id}-hearing`,
        kind: "hearing",
        title: "শুনানিতে অংশ নিন",
        detail:
          app.nextStep || "নির্ধারিত তারিখে সহকারী কমিশনার (ভূমি) কার্যালয়ে উপস্থিত থাকুন।",
        dueDate: app.deadline || today,
        applicationId: app.id,
      })
    }
  }

  const applicant: ApplicantProfile = {
    id: me?.id || "applicant",
    name: me?.displayName || "আবেদনকারী",
    accountId: me?.email || "applicant@bhoomitrace.gov.bd",
    role: "applicant",
  }

  return {
    today,
    applicant,
    applications,
    parcels,
    actionItems,
    documents,
  }
}

/**
 * Loads a single application detail by querying GET /api/v1/applications/:id
 * and optionally joining the linked parcel.
 */
export async function fetchApplication(
  id: string,
  signal?: AbortSignal,
): Promise<ApplicationDetail> {
  if (isCurrentSessionDemo()) {
    return mockFetchApplication(id, signal)
  }

  const app = await apiGet<BackendApplicationDetail>(
    `/api/v1/applications/${encodeURIComponent(id)}`,
    signal,
  )

  let parcel: Parcel | null = null
  if (app.parcelId) {
    try {
      const p = await apiGet<BackendParcel>(
        `/api/v1/parcels/${encodeURIComponent(app.parcelId)}`,
        signal,
      )
      parcel = toFrontendParcel(p)
    } catch {
      // Ignored if parcel access fails
    }
  }

  let documents: DocumentItem[] = []
  try {
    const docs = await apiGet<Page<BackendDocument>>(
      "/api/v1/documents?limit=20",
      signal,
    )
    documents = docs.items.map((d) => toDocumentItem(d, app.id, app.parcelId))
  } catch {
    // optional
  }

  return {
    ...toApplicationSummary(app),
    today: app.today || new Date().toISOString().slice(0, 10),
    timeline: app.timeline || [],
    decisionNote: app.decisionNote,
    documents,
    parcel,
  }
}

/**
 * Loads a single parcel record with its findings, reconciliation, lineage, and applications:
 * - GET /api/v1/parcels/:id
 * - GET /api/v1/parcels/:id/findings
 * - GET /api/v1/parcels/:id/reconciliation
 * - GET /api/v1/parcels/:id/lineage
 * - GET /api/v1/applications?parcelId=:id
 */
export async function fetchParcel(
  id: string,
  signal?: AbortSignal,
): Promise<ParcelDetail> {
  if (isCurrentSessionDemo()) {
    return mockFetchParcel(id, signal)
  }

  const [parcel, findingsRes, reconciliationRes, lineageRes, applicationsRes] =
    await Promise.all([
      apiGet<BackendParcel>(
        `/api/v1/parcels/${encodeURIComponent(id)}`,
        signal,
      ),
      apiGet<{ items: Finding[] }>(
        `/api/v1/parcels/${encodeURIComponent(id)}/findings`,
        signal,
      ).catch(() => ({ items: [] })),
      apiGet<ReconciliationResult>(
        `/api/v1/parcels/${encodeURIComponent(id)}/reconciliation`,
        signal,
      ).catch(() => null),
      apiGet<LineageList>(
        `/api/v1/parcels/${encodeURIComponent(id)}/lineage`,
        signal,
      ).catch(() => ({
        outgoing: [],
        incoming: [],
        arithmetic: [],
      })),
      apiGet<Page<BackendApplication>>(
        `/api/v1/applications?parcelId=${encodeURIComponent(id)}`,
        signal,
      ).catch(() => ({
        items: [] as BackendApplication[],
        total: 0,
        limit: 10,
        offset: 0,
        hasMore: false,
      })),
    ])

  const history: ParcelHistoryEntry[] = []
  for (const link of [...lineageRes.incoming, ...lineageRes.outgoing]) {
    history.push({
      survey: parcel.survey,
      year: new Date(link.createdAt).getFullYear().toString(),
      khatianNumber: parcel.khatianNumber,
      dagNumbers: parcel.dagNumbers,
      certainty: link.certainty === "confirmed" ? "confirmed" : "illustrative",
      note: link.note || `${link.relation} (${link.certainty})`,
    })
  }

  return {
    ...toFrontendParcel(parcel),
    history,
    documents: [],
    applications: applicationsRes.items.map(toApplicationSummary),
    findings: findingsRes.items,
    reconciliation: reconciliationRes || undefined,
  }
}

/**
 * Loads a source document by querying GET /api/v1/documents/:id
 */
export async function fetchDocument(
  id: string,
  signal?: AbortSignal,
): Promise<{ document: DocumentItem; today: string }> {
  if (isCurrentSessionDemo()) {
    return mockFetchDocument(id, signal)
  }

  const doc = await apiGet<BackendDocument>(
    `/api/v1/documents/${encodeURIComponent(id)}`,
    signal,
  )
  const today = new Date().toISOString().slice(0, 10)

  return {
    document: toDocumentItem(doc),
    today,
  }
}

/**
 * Creates a real certified copy application in the backend:
 * - POST /api/v1/applications (type: 'certified_copy')
 * - POST /api/v1/applications/:id/transitions (toStatus: 'submitted')
 */
export async function requestCertifiedCopy(
  parcelId: string,
): Promise<CertifiedCopyRequestResult> {
  if (isCurrentSessionDemo()) {
    return mockRequestCertifiedCopy(parcelId)
  }

  const parcel = await apiGet<BackendParcel>(
    `/api/v1/parcels/${encodeURIComponent(parcelId)}`,
  )
  const draft = await apiPost<BackendApplication>("/api/v1/applications", {
    type: "certified_copy",
    district: parcel.district,
    upazila: parcel.upazila,
    mouza: parcel.mouza,
    khatianNumber: parcel.khatianNumber,
    dagNumber: parcel.dagNumbers[0] || "1",
    areaDecimal: parcel.areaDecimal,
    share: parcel.ownershipShare,
    documents: ["id"],
    parcelId: parcel.id,
  })

  const submitted = await apiPost<BackendApplication>(
    `/api/v1/applications/${draft.id}/transitions`,
    {
      toStatus: "submitted",
      version: draft.version,
      note: "নাগরিক কর্তৃক সার্টিফাইড কপির আবেদন জমা হয়েছে।",
    },
  )

  return {
    requestId: submitted.trackingNumber || submitted.id,
    parcelId: parcel.id,
  }
}
