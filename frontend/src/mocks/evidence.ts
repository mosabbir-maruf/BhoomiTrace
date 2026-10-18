export type VersionId = "CS" | "SA" | "RS" | "BS"
export type FieldId = "khatian" | "mouza" | "dag" | "area" | "share" | "owner"
export const fieldLabels: Record<FieldId, string> = {
  khatian: "খতিয়ান নম্বর",
  mouza: "মৌজা",
  dag: "দাগ নম্বর",
  area: "জমির পরিমাণ",
  share: "মালিকানার অংশ",
  owner: "রেকর্ডভুক্ত নাম",
}
export const fieldIds: FieldId[] = [
  "khatian",
  "mouza",
  "dag",
  "area",
  "share",
  "owner",
]
export interface SyntheticRecord {
  id: VersionId
  year: string
  folio: string
  values: Record<FieldId, string>
}
const common = { mouza: "শালবন", share: "৮ আনা / ১৬ আনা", owner: "মোঃ আবদুল করিম" }
/** Purpose-built synthetic text, not OCR output or a real cadastral record. */
export const syntheticRecords: Record<VersionId, SyntheticRecord> = {
  CS: {
    id: "CS",
    year: "১৯২৪",
    folio: "০১৭",
    values: { ...common, khatian: "৪২", dag: "১২৮", area: "০.৪৮ একর" },
  },
  SA: {
    id: "SA",
    year: "১৯৬২",
    folio: "০২৩",
    values: { ...common, khatian: "৬৭", dag: "১২৮", area: "০.৫০ একর" },
  },
  RS: {
    id: "RS",
    year: "১৯৮৮",
    folio: "০৩৪",
    values: { ...common, khatian: "১০৪", dag: "৩৪১", area: "০.৫০ একর" },
  },
  BS: {
    id: "BS",
    year: "২০১৬",
    folio: "০৪১",
    values: {
      ...common,
      khatian: "২০৮",
      dag: "৭১২",
      area: "০.৩০ একর",
      share: "অস্পষ্ট",
    },
  },
}
export const versionIds: VersionId[] = ["CS", "SA", "RS", "BS"]
export const sourceLines: Record<FieldId, string> = {
  khatian: "শিরোনাম, ঘর ১",
  mouza: "শিরোনাম, ঘর ২",
  dag: "তফসিল, ঘর ১",
  area: "তফসিল, ঘর ৩",
  share: "স্বত্বের বিবরণ, ঘর ২",
  owner: "স্বত্বের বিবরণ, ঘর ১",
}
export function sourceRef(record: SyntheticRecord, field: FieldId) {
  return `${record.id} / পৃষ্ঠা ${record.folio} / ${sourceLines[field]}`
}

export const surveyNames: Record<VersionId, string> = {
  CS: "সিএস জরিপ",
  SA: "এসএ জরিপ",
  RS: "আরএস জরিপ",
  BS: "বিএস জরিপ",
}

export interface ReviewCase {
  id: string
  reference: string
  title: string
  record: VersionId
  /** Earlier survey this record is compared with. */
  compareWith: VersionId
  summary: string
  status: "new" | "in_progress" | "needs_info"
  receivedAt: string
  nextAction: string
}

/** Synthetic review cases. Status describes the demo workflow, not real urgency. */
export const reviewCases: ReviewCase[] = [
  {
    id: "case-01",
    reference: "RC-2026-014",
    title: "শালবন মৌজা, আরএস খতিয়ান ১০৪",
    record: "RS",
    compareWith: "SA",
    summary: "দাগ নম্বর ও জমির পরিমাণ আগের এসএ রেকর্ড থেকে আলাদা।",
    status: "needs_info",
    receivedAt: "2026-10-06",
    nextAction: "জমির পরিমাণ উৎস নথির সঙ্গে মিলিয়ে দেখুন",
  },
  {
    id: "case-02",
    reference: "RC-2026-015",
    title: "শালবন মৌজা, বিএস খতিয়ান ২০৮",
    record: "BS",
    compareWith: "RS",
    summary: "মালিকানার অংশ পরিষ্কার পড়া যায়নি; পরিমাণ কমেছে।",
    status: "new",
    receivedAt: "2026-10-12",
    nextAction: "অস্পষ্ট অংশটি দেখে সংশোধন প্রস্তাব করুন",
  },
  {
    id: "case-03",
    reference: "RC-2026-011",
    title: "শালবন মৌজা, এসএ খতিয়ান ৬৭",
    record: "SA",
    compareWith: "CS",
    summary: "খতিয়ান নম্বর ও পরিমাণে ছোট পার্থক্য।",
    status: "in_progress",
    receivedAt: "2026-09-29",
    nextAction: "বাকি তথ্যগুলোর পর্যালোচনা শেষ করুন",
  },
]

export const caseStatusLabel: Record<ReviewCase["status"], string> = {
  new: "নতুন",
  in_progress: "পর্যালোচনা চলছে",
  needs_info: "আরও যাচাই দরকার",
}

/*
  Record lineage in the sample. "sample" links are part of the fixtures;
  "illustrative" links are plausible connections that nobody has confirmed.
*/
export interface LineageNode {
  id: string
  version: VersionId
  year: string
  khatian: string
  dag: string
  area: string
}

export interface LineageLink {
  from: string
  to: string
  kind: "continued" | "renumbered" | "split"
  certainty: "sample" | "illustrative"
  reference: string
  note: string
}

export const lineageNodes: LineageNode[] = [
  {
    id: "CS-42",
    version: "CS",
    year: "১৯২৪",
    khatian: "৪২",
    dag: "১২৮",
    area: "০.৪৮ একর",
  },
  {
    id: "SA-67",
    version: "SA",
    year: "১৯৬২",
    khatian: "৬৭",
    dag: "১২৮",
    area: "০.৫০ একর",
  },
  {
    id: "RS-104",
    version: "RS",
    year: "১৯৮৮",
    khatian: "১০৪",
    dag: "৩৪১",
    area: "০.৫০ একর",
  },
  {
    id: "BS-208",
    version: "BS",
    year: "২০১৬",
    khatian: "২০৮",
    dag: "৭১২",
    area: "০.৩০ একর",
  },
  {
    id: "BS-209",
    version: "BS",
    year: "২০১৬",
    khatian: "২০৯",
    dag: "৭১৩",
    area: "০.২০ একর",
  },
]

export const lineageLinks: LineageLink[] = [
  {
    from: "CS-42",
    to: "SA-67",
    kind: "continued",
    certainty: "sample",
    reference: "CS পৃষ্ঠা ০১৭ / SA পৃষ্ঠা ০২৩, তফসিল ঘর ১",
    note: "একই দাগ নম্বর ১২৮; মালিকের নাম একই।",
  },
  {
    from: "SA-67",
    to: "RS-104",
    kind: "renumbered",
    certainty: "illustrative",
    reference: "SA পৃষ্ঠা ০২৩ / RS পৃষ্ঠা ০৩৪",
    note: "আরএস জরিপে দাগ ৩৪১ হিসেবে দেখানো; পুরোনো নম্বরের সঙ্গে সংযোগের নথি নমুনায় নেই।",
  },
  {
    from: "RS-104",
    to: "BS-208",
    kind: "split",
    certainty: "sample",
    reference: "RS পৃষ্ঠা ০৩৪ / BS পৃষ্ঠা ০৪১",
    note: "০.৫০ একরের মধ্যে ০.৩০ একর এই খতিয়ানে।",
  },
  {
    from: "RS-104",
    to: "BS-209",
    kind: "split",
    certainty: "illustrative",
    reference: "BS পৃষ্ঠা ০৪২ (নমুনায় আংশিক)",
    note: "বাকি ০.২০ একর সম্ভবত এই খতিয়ানে; মিলিয়ে দেখা হয়নি।",
  },
]

/** Values the synthetic reader could not read clearly. */
export function isUnclear(value: string) {
  return value === "অস্পষ্ট"
}
