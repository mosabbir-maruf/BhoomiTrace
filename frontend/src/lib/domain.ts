import type {
  ApplicationStatus,
  ApplicationType,
  ActionItemKind,
  CaseStatus,
  DocumentStatus,
  FindingKind,
  FindingSeverity,
  FindingStatus,
} from "./api/types"
import type { IconName } from "@/components/ui/Icon"

export type Tone = "neutral" | "info" | "warning" | "success" | "danger"

interface StatusMeta {
  label: string
  tone: Tone
  icon: IconName
}

/** Plain-language meaning of each status, shown on detail pages and in help. */
export const applicationStatusExplain: Record<ApplicationStatus, string> = {
  draft: "আবেদনটি এখনো শেষ হয়নি এবং কোথাও জমা হয়নি। যেকোনো সময় চালিয়ে যেতে পারেন।",
  submitted: "আবেদন জমা হয়েছে, এখনো দেখা শুরু হয়নি।",
  under_review: "অফিসে আবেদনটি দেখা হচ্ছে। এখন আপনার কিছু করার নেই।",
  documents_required:
    "আবেদন এগিয়ে নিতে আরও নথি দরকার। নির্দিষ্ট তারিখের মধ্যে জমা দিন।",
  hearing_scheduled:
    "শুনানির তারিখ দেওয়া হয়েছে। নির্দিষ্ট দিনে প্রয়োজনীয় কাগজসহ উপস্থিত থাকুন।",
  approved: "আবেদনটি অনুমোদিত হয়েছে।",
  rejected: "আবেদনটি অনুমোদন পায়নি। কারণ দেখে চাইলে নতুন আবেদন করতে পারেন।",
}

export const documentStatusMeta: Record<DocumentStatus, StatusMeta> = {
  requested: { label: "জমা বাকি", tone: "warning", icon: "alert" },
  in_review: { label: "দেখা হচ্ছে", tone: "info", icon: "clock" },
  submitted: { label: "জমা হয়েছে", tone: "success", icon: "check" },
}

/**
 * Human labels for the checklist codes a filing declares at submission.
 *
 * These are the codes the API accepts on `POST /applications` (`deed`, `id`,
 * `khatian`, `tax`, `heir`). An unknown code falls back to the raw value so a
 * server-side vocabulary change is visible rather than silently dropped.
 */
export const declaredDocumentLabel: Record<string, string> = {
  deed: "দলিলের কপি",
  id: "পরিচয়পত্রের কপি",
  khatian: "খতিয়ান/খতিয়ানের কপি",
  tax: "খাজনা পরিশোধের রসিদ",
  heir: "ওয়ারিশ সনদ",
}

export function declaredDocumentLabelFor(code: string): string {
  return declaredDocumentLabel[code] ?? code
}

export const caseStatusMeta: Record<CaseStatus, StatusMeta> = {
  needs_info: { label: "আরও যাচাই দরকার", tone: "warning", icon: "alert" },
  new: { label: "নতুন", tone: "info", icon: "info" },
  in_progress: { label: "পর্যালোচনা চলছে", tone: "neutral", icon: "clock" },
}

export const applicationStatusMeta: Record<ApplicationStatus, StatusMeta> = {
  draft: { label: "খসড়া", tone: "neutral", icon: "pencil" },
  submitted: { label: "জমা দেওয়া হয়েছে", tone: "info", icon: "send" },
  under_review: { label: "পর্যালোচনাধীন", tone: "info", icon: "clock" },
  documents_required: { label: "নথি প্রয়োজন", tone: "warning", icon: "alert" },
  hearing_scheduled: {
    label: "শুনানি নির্ধারিত",
    tone: "warning",
    icon: "calendar",
  },
  approved: { label: "অনুমোদিত", tone: "success", icon: "check" },
  rejected: { label: "নামঞ্জুর", tone: "danger", icon: "xCircle" },
}

export const applicationStatusOrder: ApplicationStatus[] = [
  "draft",
  "submitted",
  "under_review",
  "documents_required",
  "hearing_scheduled",
  "approved",
  "rejected",
]

export const applicationTypeLabel: Record<ApplicationType, string> = {
  mutation: "নামজারি",
  record_correction: "খতিয়ান সংশোধন",
  certified_copy: "খতিয়ানের সার্টিফাইড কপি",
}

export const actionKindMeta: Record<ActionItemKind, {
  label: string
  icon: IconName
}> = {
  hearing: { label: "শুনানি", icon: "calendar" },
  document: { label: "নথি জমা", icon: "upload" },
}

/** Statuses that still need processing; drafts and closed applications are excluded. */
export function isActiveStatus(status: ApplicationStatus): boolean {
  return status !== "draft" && status !== "approved" && status !== "rejected"
}

export const surveyLabel = {
  CS: "সিএস",
  SA: "এসএ",
  RS: "আরএস",
  BS: "বিএস",
} as const

export const findingSeverityMeta: Record<FindingSeverity, StatusMeta> = {
  info: { label: "তথ্যমূলক", tone: "info", icon: "info" },
  low: { label: "কম গুরুত্বপূর্ণ", tone: "info", icon: "info" },
  medium: { label: "মাঝারি গুরুত্ব", tone: "warning", icon: "alert" },
  high: { label: "উচ্চ গুরুত্ব", tone: "danger", icon: "alert" },
  critical: { label: "জরুরি অসঙ্গতি", tone: "danger", icon: "xCircle" },
}

export const findingStatusMeta: Record<FindingStatus, StatusMeta> = {
  open: { label: "খোলা পর্যবেক্ষণ", tone: "warning", icon: "alert" },
  under_review: { label: "তদন্তাধীন", tone: "info", icon: "clock" },
  resolved: { label: "মীমাংসিত", tone: "success", icon: "check" },
  dismissed: { label: "খারিজ", tone: "neutral", icon: "close" },
}

export const findingKindLabel: Record<FindingKind, string> = {
  area_mismatch: "জমির পরিমাণের গরমিল",
  area_discrepancy: "জমির পরিমাণের গরমিল",
  share_mismatch: "অংশের অমিল",
  dag_mismatch: "দাগ নম্বরের অমিল",
  khatian_mismatch: "খতিয়ান নম্বরের অমিল",
  mouza_mismatch: "মৌজার অমিল",
  lineage_break: "ধারাবাহিকতার বিচ্যুতি",
  unclear_reading: "অস্পষ্ট পাঠ",
  unclear_folio: "অস্পষ্ট পাঠ",
  ownership_gap: "মালিকানার তথ্যে ফাঁক",
  document_required: "অতিরিক্ত নথি প্রয়োজন",
  other: "অন্যান্য পর্যবেক্ষণ",
}
