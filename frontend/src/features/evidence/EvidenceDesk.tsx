import { useState } from "react"
import { recordReviewOutcome } from "@/lib/api/review"
import type { ReviewOutcome } from "@/lib/api/types"
import { routeHref } from "@/config/navigation"
import { navigate } from "@/hooks/useHashRoute"
import {
  clearReviewResult,
  reviewKey,
  saveReviewResult,
  useReviewResults,
} from "@/mocks/reviewStore"
import { isCurrentSessionLive, startDemo } from "@/lib/api/session"
import { formatDate } from "@/lib/format"
import Button, { LinkButton } from "@/components/ui/Button"
import { SelectField, TextField } from "@/components/ui/Field"
import Icon from "@/components/ui/Icon"
import { Page, Panel } from "@/components/ui/Layout"
import { Notice } from "@/components/ui/States"
import StatusBadge from "@/components/ui/StatusBadge"
import {
  caseStatusLabel,
  fieldIds,
  fieldLabels,
  isUnclear,
  reviewCases,
  sourceRef,
  surveyNames,
  syntheticRecords,
  versionIds,
  type FieldId,
} from "@/mocks/evidence"
import type { Tone } from "@/lib/domain"
import type { IconName } from "@/components/ui/Icon"

const outcomeMeta: Record<ReviewOutcome | "pending", {
  label: string
  tone: Tone
  icon: IconName
}> = {
  pending: { label: "পর্যালোচনা বাকি", tone: "neutral", icon: "clock" },
  verified: { label: "যাচাই করা হয়েছে", tone: "success", icon: "check" },
  correction: { label: "সংশোধন প্রস্তাবিত", tone: "info", icon: "pencil" },
  needs_review: { label: "আরও পর্যালোচনা দরকার", tone: "warning", icon: "alert" },
  dismissed: { label: "খারিজ", tone: "neutral", icon: "close" },
}

/** The synthetic source page. Each value is a selectable region tied to one field. */
function SourceDocument({
  caseIndex,
  selected,
  onSelect,
}: {
  caseIndex: number
  selected: FieldId
  onSelect: (f: FieldId) => void
}) {
  const record = syntheticRecords[reviewCases[caseIndex].record]
  const Region = ({ field }: { field: FieldId }) => {
    const active = selected === field
    return (
      <button
        type="button"
        onClick={() => onSelect(field)}
        aria-pressed={active}
        aria-label={`${fieldLabels[field]}: ${record.values[field]}`}
        className={`rounded-sm border-2 px-1.5 py-0.5 text-left font-display transition-colors duration-150 ${
          active
            ? "border-warning bg-highlight"
            : "border-transparent hover:border-rule-strong"
        }`}
      >
        {record.values[field]}
      </button>
    )
  }
  return (
    <div
      className="rounded-md border border-rule bg-folio p-5 text-ink sm:p-6"
      aria-label="কৃত্রিম উৎস নথি"
      role="group"
    >
      <p className="text-center text-sm text-ink-muted">
        নমুনা নথি, {surveyNames[record.id]} {record.year}, পৃষ্ঠা {record.folio}
      </p>
      <p className="mt-1 text-center font-display text-lg font-semibold">
        খতিয়ান
      </p>
      <div className="mt-4 grid grid-cols-2 gap-3 border-y border-rule py-3">
        <div>
          <span className="block text-sm text-ink-muted">খতিয়ান নং</span>
          <Region field="khatian" />
        </div>
        <div>
          <span className="block text-sm text-ink-muted">মৌজা</span>
          <Region field="mouza" />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3 border-b border-rule py-3">
        <div>
          <span className="block text-sm text-ink-muted">মালিকের নাম</span>
          <Region field="owner" />
        </div>
        <div>
          <span className="block text-sm text-ink-muted">অংশ</span>
          <Region field="share" />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3 py-3">
        <div>
          <span className="block text-sm text-ink-muted">দাগ নং</span>
          <Region field="dag" />
        </div>
        <div>
          <span className="block text-sm text-ink-muted">পরিমাণ</span>
          <Region field="area" />
        </div>
      </div>
      <p className="mt-2 text-sm text-ink-muted">
        কাল্পনিক নথি। কোনো আসল খতিয়ানের ছবি বা ওসিআর ফল নয়।
      </p>
    </div>
  )
}

export default function EvidenceDesk({ caseId }: { caseId?: string }) {
  if (isCurrentSessionLive()) {
    return (
      <Page
        title="নথি যাচাই (ইন্টারেক্টিভ প্রমাণপত্র)"
        breadcrumbs={[
          { label: "পর্যালোচনার তালিকা", href: routeHref("queue") },
          { label: "নথি যাচাই" },
        ]}
      >
        <div className="space-y-6">
          <Notice tone="info" title="ইন্টারেক্টিভ ওসিআর ও বহুভুজ প্রমাণপত্র অপ্রাপ্য">
            বর্তমান BhoomiTrace ব্যাকএন্ড এপিআই-তে ইন্টারেক্টিভ বহুভুজ (OCR Polygon Overlay) ও সরাসরি ছবি-সংলগ্ন প্রমাণপত্র যাচাই সেবা সংযুক্ত নয়।
            সরাসরি ব্যাকএন্ড ডেটা পর্যালোচনার জন্য অনুগ্রহ করে{" "}
            <a href={routeHref("queue")} className="text-link font-semibold underline">
              পর্যালোচনার কার্যতালিকা (Queue)
            </a>{" "}
            ব্যবহার করুন যেখানে অসঙ্গতি পর্যবেক্ষণ (Findings) ও ফিল্ড এক্সট্রাকশন তালিকা পর্যালোচনা করা যায়।
          </Notice>
          <div className="rounded-md border border-rule bg-surface p-6">
            <h3 className="font-semibold text-ink">প্রোটোটাইপ ডেমো দেখতে চান?</h3>
            <p className="mt-2 text-sm text-ink-muted">
              ফিজিমা ও ইন্টারফেস প্রোটোটাইপের জন্য প্রস্তুতকৃত ইন্টারেক্টিভ নথি যাচাই ব্যবস্থাটি কাল্পনিক ডেটা দিয়ে দেখার জন্য ডেমো মোড সক্রিয় করুন।
            </p>
            <div className="mt-4 flex flex-wrap gap-3">
              <Button
                variant="secondary"
                onClick={() => {
                  startDemo("reviewer")
                  navigate(routeHref("desk"))
                }}
              >
                পর্যালোচক ডেমো মোডে প্রোটোটাইপ দেখুন
              </Button>
              <LinkButton href={routeHref("queue")}>
                পর্যালোচনার তালিকায় ফিরুন
              </LinkButton>
            </div>
          </div>
        </div>
      </Page>
    )
  }

  const caseIndex = Math.max(
    0,
    reviewCases.findIndex((c) => c.id === caseId),
  )
  const [field, setField] = useState<FieldId>("area")
  const [tab, setTab] = useState<"field" | "differences" | "history">("field")
  const results = useReviewResults()
  const [mode, setMode] = useState<null | "correction" | "needs_review">(null)
  const [proposed, setProposed] = useState("")
  const [note, setNote] = useState("")
  const [error, setError] = useState("")
  const [saving, setSaving] = useState(false)

  const reviewCase = reviewCases[caseIndex]
  const crumbs = [
    { label: "পর্যালোচনার তালিকা", href: routeHref("queue") },
    { label: reviewCase.reference },
  ]
  const record = syntheticRecords[reviewCase.record]
  const earlier = syntheticRecords[reviewCase.compareWith]
  const key = (f: FieldId) => reviewKey(reviewCase.id, f)
  const result = results[key(field)]
  const value = record.values[field]
  const differences = fieldIds.filter(
    (f) => record.values[f] !== earlier.values[f],
  )
  const done = fieldIds.filter((f) => results[key(f)]).length

  const resetForm = () => {
    setMode(null)
    setProposed("")
    setNote("")
    setError("")
  }
  const selectField = (f: FieldId) => {
    setField(f)
    setTab("field")
    resetForm()
  }

  const save = async (outcome: ReviewOutcome) => {
    if (outcome === "correction" && !proposed.trim()) {
      setError("প্রস্তাবিত সঠিক মান লিখুন।")
      return
    }
    if (outcome === "needs_review" && !note.trim()) {
      setError("কেন আরও পর্যালোচনা দরকার, সংক্ষেপে লিখুন।")
      return
    }
    setSaving(true)
    const saved = await recordReviewOutcome({
      caseId: reviewCase.id,
      fieldId: field,
      outcome,
      extractedValue: value,
      proposedValue: outcome === "correction" ? proposed.trim() : undefined,
      note: note.trim() || undefined,
    })
    setSaving(false)
    saveReviewResult(saved)
    resetForm()
  }

  const tabs = [
    { id: "field", label: "নির্বাচিত তথ্য" },
    {
      id: "differences",
      label: `আগের রেকর্ডের সঙ্গে পার্থক্য (${differences.length.toLocaleString("bn-BD")})`,
    },
    { id: "history", label: "রেকর্ডের ইতিহাস" },
  ] as const

  return (
    <Page
      title="নথি যাচাই"
      breadcrumbs={crumbs}
      description="মামলা বেছে নিন → তথ্য বেছে নিন → উৎস মিলিয়ে দেখুন → সিদ্ধান্ত লিখুন। সিদ্ধান্ত শুধু এই ডেমোতে থাকে; পাতা রিফ্রেশ করলে মুছে যায়।"
    >
      <div className="mb-4">
        <Notice tone="info" title="ডেমো মোড — কাল্পনিক নমুনা ডেটা">
          এই ইন্টারেক্টিভ নথি যাচাই স্ক্রিনটি প্রোটোটাইপ প্রদর্শনীমূলক। এখানে প্রদর্শিত
          রেকর্ড, বহুভুজ চিহ্নিতকরণ ও সিদ্ধান্ত কাল্পনিক এবং শুধুমাত্র এই ডেমো পরিবেশের জন্য প্রযোজ্য।
        </Notice>
      </div>
      <div className="mb-6 grid gap-4 sm:grid-cols-[minmax(0,24rem)_1fr] sm:items-end">
        <SelectField
          label="১. মামলা বেছে নিন"
          value={reviewCase.id}
          onChange={(e) => {
            selectField("area")
            navigate(routeHref("case", e.target.value))
          }}
          options={reviewCases.map((c) => ({
            value: c.id,
            label: `${c.reference} · ${c.title}`,
          }))}
        />
        <p role="status" className="text-ink-muted">
          এই মামলায় {done.toLocaleString("bn-BD")}/
          {fieldIds.length.toLocaleString("bn-BD")}টি তথ্যের পর্যালোচনা হয়েছে
        </p>
      </div>

      <div className="mb-6 flex flex-col gap-3 rounded-md border border-rule bg-surface p-4 md:flex-row md:items-center md:justify-between">
        <div>
          <p className="font-medium">{reviewCase.title}</p>
          <p className="text-sm text-ink-muted">
            {caseStatusLabel[reviewCase.status]} · গ্রহণ{" "}
            {formatDate(reviewCase.receivedAt)} · {reviewCase.summary}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <a
            className="inline-flex min-h-11 items-center rounded-sm border border-rule px-3 font-medium hover:bg-paper"
            href={routeHref("compare", undefined, { case: reviewCase.id })}
          >
            পাশাপাশি মিলিয়ে দেখুন
          </a>
          <a
            className="inline-flex min-h-11 items-center rounded-sm border border-rule px-3 font-medium hover:bg-paper"
            href={routeHref("lineage", undefined, { case: reviewCase.id })}
          >
            রেকর্ডের ধারা
          </a>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2 lg:items-start">
        <section aria-labelledby="src-h" className="lg:sticky lg:top-24">
          <h2 id="src-h" className="mb-3 text-xl font-semibold">
            উৎস নথি{" "}
            <span className="text-base font-normal text-ink-muted">
              (৩. নির্বাচিত অংশ হলুদ চিহ্নিত)
            </span>
          </h2>
          <SourceDocument
            caseIndex={caseIndex}
            selected={field}
            onSelect={selectField}
          />
        </section>

        <section aria-labelledby="fields-h">
          <h2 id="fields-h" className="mb-3 text-xl font-semibold">
            ২. তথ্য বেছে নিন
          </h2>
          <ul className="mb-5 grid grid-cols-2 gap-2 sm:grid-cols-3">
            {fieldIds.map((f) => {
              const r = results[key(f)]
              const meta = outcomeMeta[r?.outcome ?? "pending"]
              return (
                <li key={f}>
                  <button
                    type="button"
                    onClick={() => selectField(f)}
                    aria-pressed={field === f}
                    className={`flex min-h-14 w-full flex-col items-start rounded-sm border px-3 py-2 text-left ${
                      field === f
                        ? "border-accent bg-accent-soft"
                        : "border-rule bg-surface hover:bg-sunken"
                    }`}
                  >
                    <span className="font-medium">{fieldLabels[f]}</span>
                    <span className="flex items-center gap-1 text-sm text-ink-muted">
                      <Icon name={meta.icon} className="size-3.5" />
                      {meta.label}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>

          <Panel>
            <div
              role="tablist"
              aria-label="বিস্তারিত"
              className="flex overflow-x-auto border-b border-rule"
            >
              {tabs.map((t) => (
                <button
                  key={t.id}
                  id={`tab-${t.id}`}
                  role="tab"
                  type="button"
                  aria-selected={tab === t.id}
                  aria-controls="tab-panel"
                  tabIndex={tab === t.id ? 0 : -1}
                  onClick={() => setTab(t.id)}
                  onKeyDown={(e) => {
                    // ARIA tabs pattern: arrow keys move between tabs, Home/End jump to the ends.
                    const i = tabs.findIndex((x) => x.id === t.id)
                    const to =
                      e.key === "ArrowRight"
                        ? (i + 1) % tabs.length
                        : e.key === "ArrowLeft"
                          ? (i - 1 + tabs.length) % tabs.length
                          : e.key === "Home"
                            ? 0
                            : e.key === "End"
                              ? tabs.length - 1
                              : -1
                    if (to < 0) return
                    e.preventDefault()
                    setTab(tabs[to].id)
                    document.getElementById(`tab-${tabs[to].id}`)?.focus()
                  }}
                  className={`min-h-12 shrink-0 border-b-2 px-4 text-sm font-medium transition-colors duration-150 ${
                    tab === t.id
                      ? "border-accent text-accent"
                      : "border-transparent text-ink-muted hover:text-ink"
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>

            <div
              id="tab-panel"
              role="tabpanel"
              tabIndex={0}
              aria-labelledby={`tab-${tab}`}
              className="p-5"
            >
              {tab === "field" && (
                <div className="space-y-5">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="text-sm text-ink-muted">
                        নথি থেকে পড়া মান ({fieldLabels[field]})
                      </p>
                      <p className="font-display text-2xl font-semibold">
                        {value}
                      </p>
                    </div>
                    <StatusBadge
                      {...outcomeMeta[result?.outcome ?? "pending"]}
                    />
                  </div>
                  <dl className="space-y-1 text-sm">
                    <div>
                      <dt className="inline text-ink-muted">উৎস: </dt>
                      <dd className="inline">{sourceRef(record, field)}</dd>
                    </div>
                    <div>
                      <dt className="inline text-ink-muted">
                        {surveyNames[earlier.id]}-এ ছিল:{" "}
                      </dt>
                      <dd className="inline">{earlier.values[field]}</dd>
                    </div>
                  </dl>
                  {isUnclear(value) && (
                    <Notice tone="warning" title="মানটি পরিষ্কার পড়া যায়নি">
                      উৎস নথিতে অংশটি দেখে প্রয়োজনে সংশোধন প্রস্তাব করুন।
                    </Notice>
                  )}

                  {result ? (
                    <div className="space-y-3">
                      <Notice
                        tone="success"
                        title={`সিদ্ধান্ত লেখা হয়েছে: ${outcomeMeta[result.outcome].label}`}
                      >
                        শুধু এই ব্রাউজারের ডেমোতে রাখা হয়েছে, কোথাও পাঠানো হয়নি।
                        {result.proposedValue && (
                          <span className="mt-1 block">
                            পড়া মান: <strong>{result.extractedValue}</strong> →
                            পর্যালোচকের প্রস্তাব:{" "}
                            <strong>{result.proposedValue}</strong>
                          </span>
                        )}
                        {result.note && (
                          <span className="mt-1 block">
                            মন্তব্য: {result.note}
                          </span>
                        )}
                      </Notice>
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => clearReviewResult(reviewCase.id, field)}
                      >
                        সিদ্ধান্ত বদলান
                      </Button>
                    </div>
                  ) : (
                    <div className="border-t border-rule pt-5">
                      <h3 className="mb-3 font-semibold">৪. পর্যালোচনার সিদ্ধান্ত</h3>
                      {mode === null ? (
                        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
                          <Button
                            icon="check"
                            onClick={() => save("verified")}
                            loading={saving}
                          >
                            যাচাই হিসেবে চিহ্নিত করুন
                          </Button>
                          <Button
                            variant="secondary"
                            icon="pencil"
                            onClick={() => setMode("correction")}
                          >
                            সংশোধন প্রস্তাব করুন
                          </Button>
                          <Button
                            variant="secondary"
                            icon="alert"
                            onClick={() => setMode("needs_review")}
                          >
                            আরও পর্যালোচনা দরকার
                          </Button>
                        </div>
                      ) : (
                        <form
                          className="space-y-4"
                          onSubmit={(e) => {
                            e.preventDefault()
                            void save(mode)
                          }}
                        >
                          {mode === "correction" && (
                            <TextField
                              label="প্রস্তাবিত সঠিক মান"
                              hint={`পড়া মান "${value}" বদলাবে না; আপনার প্রস্তাব আলাদাভাবে রাখা হবে।`}
                              value={proposed}
                              error={
                                error && !proposed.trim() ? error : undefined
                              }
                              onChange={(e) => setProposed(e.target.value)}
                              autoFocus
                            />
                          )}
                          <TextField
                            label={
                              mode === "needs_review" ? "কারণ" : "মন্তব্য (ঐচ্ছিক)"
                            }
                            value={note}
                            error={
                              mode === "needs_review" && error
                                ? error
                                : undefined
                            }
                            onChange={(e) => setNote(e.target.value)}
                            autoFocus={mode === "needs_review"}
                          />
                          <div className="flex flex-wrap gap-2">
                            <Button type="submit" loading={saving}>
                              {mode === "correction"
                                ? "সংশোধন প্রস্তাব সংরক্ষণ"
                                : "আরও পর্যালোচনার জন্য চিহ্নিত করুন"}
                            </Button>
                            <Button variant="ghost" onClick={resetForm}>
                              বাতিল
                            </Button>
                          </div>
                        </form>
                      )}
                    </div>
                  )}
                </div>
              )}

              {tab === "differences" && (
                <div className="space-y-3">
                  <p className="text-sm text-ink-muted">
                    {surveyNames[record.id]} আর {surveyNames[earlier.id]}-এর
                    মধ্যে যেসব মান আলাদা। পার্থক্য মানেই ভুল, জালিয়াতি বা মালিকানার সিদ্ধান্ত নয়;
                    জরিপে নম্বর বদলানো স্বাভাবিক।
                  </p>
                  {differences.length === 0 ? (
                    <p>কোনো পার্থক্য নেই।</p>
                  ) : (
                    <ul className="divide-y divide-rule rounded-sm border border-rule">
                      {differences.map((f) => (
                        <li
                          key={f}
                          className="flex flex-wrap items-center justify-between gap-2 px-4 py-3"
                        >
                          <span>
                            <span className="block font-medium">
                              {fieldLabels[f]}
                            </span>
                            <span className="text-sm text-ink-muted">
                              {earlier.values[f]} → {record.values[f]}
                            </span>
                          </span>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => selectField(f)}
                          >
                            দেখুন
                          </Button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}

              {tab === "history" && (
                <div>
                  <p className="mb-3 text-sm text-ink-muted">
                    বিভিন্ন জরিপে "{fieldLabels[field]}"-এর মান (কাল্পনিক)।
                  </p>
                  <ol className="divide-y divide-rule rounded-sm border border-rule">
                    {versionIds.map((v) => (
                      <li
                        key={v}
                        className={`grid grid-cols-[8rem_minmax(0,1fr)] gap-3 px-4 py-2.5 ${
                          v === record.id ? "bg-accent-soft font-medium" : ""
                        }`}
                      >
                        <span>
                          {surveyNames[v]} {syntheticRecords[v].year}
                        </span>
                        <span>{syntheticRecords[v].values[field]}</span>
                      </li>
                    ))}
                  </ol>
                </div>
              )}
            </div>
          </Panel>
        </section>
      </div>
    </Page>
  )
}
