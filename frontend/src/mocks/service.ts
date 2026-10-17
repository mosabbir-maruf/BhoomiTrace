import type {
  ApplicantDashboard,
  ApplicationDetail,
  CertifiedCopyRequestResult,
  DocumentItem,
  Finding,
  NewApplicationDraft,
  NewApplicationResult,
  ParcelDetail,
  ReconciliationResult,
  ReviewCaseSummary,
  ReviewFindingInput,
  ReviewFindingResult,
  ReviewOutcomeInput,
  ReviewOutcomeResult,
} from "@/lib/api/types"
import {
  DEMO_TODAY,
  actionItems,
  applications,
  documents,
  parcelHistory,
  parcels,
  sampleApplicant,
  sampleFindings,
  sampleReconciliation,
  summaryOf,
} from "./data"
import { reviewCases } from "./evidence"
import { saveFindingDecision } from "./findingStore"

/** Sample scenarios let reviewers see loading, empty and error states without a backend. */
export type MockScenario = "normal" | "slow" | "empty" | "error"

export const mockScenarios: readonly MockScenario[] = [
  "normal",
  "slow",
  "empty",
  "error",
]

function readInitialScenario(): MockScenario {
  if (typeof window === "undefined") return "normal"
  const value = new URLSearchParams(window.location.search).get("scenario")
  return mockScenarios.includes(value as MockScenario)
    ? value as MockScenario
    : "normal"
}

let scenario: MockScenario = readInitialScenario()
const listeners = new Set<() => void>()

export function getMockScenario(): MockScenario {
  return scenario
}

export function setMockScenario(next: MockScenario): void {
  scenario = next
  listeners.forEach((listener) => listener())
}

export function subscribeMockScenario(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer)
        reject(new DOMException("Aborted", "AbortError"))
      },
      { once: true },
    )
  })
}

/** Thrown when a requested record ID does not exist in the sample data. */
export class NotFoundError extends Error {
  constructor(what: string) {
    super(`${what} not found`)
    this.name = "NotFoundError"
  }
}

async function respond(signal?: AbortSignal) {
  await delay(scenario === "slow" ? 3500 : 450, signal)
  if (scenario === "error") throw new Error("Sample error: request failed")
}

export async function mockFetchApplicantDashboard(
  signal?: AbortSignal,
): Promise<ApplicantDashboard> {
  await respond(signal)
  if (scenario === "empty")
    return {
      today: DEMO_TODAY,
      applicant: sampleApplicant,
      applications: [],
      parcels: [],
      actionItems: [],
      documents: [],
    }
  return structuredClone({
    today: DEMO_TODAY,
    applicant: sampleApplicant,
    applications: applications.map(summaryOf),
    parcels,
    actionItems,
    documents,
  })
}

export async function mockFetchApplication(
  id: string,
  signal?: AbortSignal,
): Promise<ApplicationDetail> {
  await respond(signal)
  const app =
    scenario === "empty" ? undefined : applications.find((a) => a.id === id)
  if (!app) throw new NotFoundError("application")
  return structuredClone({
    ...app,
    today: DEMO_TODAY,
    documents: documents.filter((d) => d.applicationId === id),
    parcel: parcels.find((p) => p.id === app.parcelId) ?? null,
  })
}

export async function mockFetchParcel(
  id: string,
  signal?: AbortSignal,
): Promise<ParcelDetail> {
  await respond(signal)
  const parcel =
    scenario === "empty" ? undefined : parcels.find((p) => p.id === id)
  if (!parcel) throw new NotFoundError("parcel")
  return structuredClone({
    ...parcel,
    history: parcelHistory[id] ?? [],
    documents: documents.filter((d) => d.parcelId === id),
    applications: applications.filter((a) => a.parcelId === id).map(summaryOf),
    findings: sampleFindings.filter((f) => f.parcelId === id),
    reconciliation: sampleReconciliation[id],
  })
}

export async function mockFetchDocument(
  id: string,
  signal?: AbortSignal,
): Promise<{ document: DocumentItem; today: string }> {
  await respond(signal)
  const document =
    scenario === "empty" ? undefined : documents.find((d) => d.id === id)
  if (!document) throw new NotFoundError("document")
  return structuredClone({ document, today: DEMO_TODAY })
}

let requestCounter = 430

export async function mockRequestCertifiedCopy(
  parcelId: string,
): Promise<CertifiedCopyRequestResult> {
  await delay(scenario === "slow" ? 3000 : 600)
  if (scenario === "error")
    throw new Error("Sample error: request was not accepted")
  requestCounter += 1
  return { requestId: `DEMO-CC-${requestCounter}`, parcelId }
}

let demoCounter = 0

/** Returns a local demo reference. Nothing leaves the browser. */
export async function mockSubmitApplication(
  draft: NewApplicationDraft,
): Promise<NewApplicationResult> {
  await delay(scenario === "slow" ? 2500 : 600)
  if (scenario === "error")
    throw new Error("Sample error: application was not accepted")
  demoCounter += 1
  void draft
  return {
    referenceId: `DEMO-2026-${String(demoCounter).padStart(3, "0")}`,
    demo: true,
  }
}

export async function mockFetchReviewCases(
  signal?: AbortSignal,
): Promise<ReviewCaseSummary[]> {
  await respond(signal)
  if (scenario === "empty") return []
  return reviewCases.map(
    ({ id, reference, title, summary, status, receivedAt, nextAction }) => ({
      id,
      reference,
      title,
      summary,
      status,
      receivedAt,
      nextAction,
    }),
  )
}

export async function mockRecordReviewOutcome(
  input: ReviewOutcomeInput,
): Promise<ReviewOutcomeResult> {
  await delay(250)
  return { ...input, recordedAt: DEMO_TODAY, demo: true }
}

export async function mockFetchFindingsForParcel(
  parcelId: string,
  signal?: AbortSignal,
): Promise<Finding[]> {
  await respond(signal)
  if (scenario === "empty") return []
  return structuredClone(sampleFindings.filter((f) => f.parcelId === parcelId))
}

export async function mockFetchAllFindings(
  signal?: AbortSignal,
): Promise<Finding[]> {
  await respond(signal)
  if (scenario === "empty") return []
  return structuredClone(sampleFindings)
}

export async function mockFetchReconciliation(
  parcelId: string,
  signal?: AbortSignal,
): Promise<ReconciliationResult | null> {
  await respond(signal)
  if (scenario === "empty") return null
  return structuredClone(sampleReconciliation[parcelId] ?? null)
}

let decisionCounter = 100

export async function mockReviewFinding(
  input: ReviewFindingInput,
): Promise<ReviewFindingResult> {
  await delay(scenario === "slow" ? 2000 : 350)
  if (scenario === "error")
    throw new Error("Sample error: finding review failed")
  const target = sampleFindings.find((f) => f.id === input.findingId)
  if (!target) throw new NotFoundError("finding")

  decisionCounter += 1
  saveFindingDecision(input.findingId, input.action, input.reason)

  // Update mock in-memory finding
  target.status = input.action
  target.updatedAt = DEMO_TODAY
  target.version = input.version + 1

  return {
    finding: structuredClone(target),
    decision: {
      id: `00000000-0000-0000-0000-${String(decisionCounter).padStart(12, "0")}`,
      findingId: input.findingId,
      extractionId: null,
      reviewerId: "00000000-0000-0000-0000-000000000001",
      outcome:
        input.action === "resolved"
          ? "verified"
          : input.action === "dismissed"
            ? "dismissed"
            : "needs_review",
      findingAction: input.action,
      extractedValue: null,
      proposedValue: null,
      note: input.reason ?? null,
      createdAt: DEMO_TODAY,
    },
  }
}
