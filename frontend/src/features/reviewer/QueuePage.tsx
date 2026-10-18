import { useState } from "react"
import {
  fetchAllFindings,
  fetchReviewCases,
  recordFindingReview,
} from "@/lib/api/review"
import type {
  Finding,
  FindingReviewAction,
  FindingSeverity,
  FindingStatus,
  ReviewCaseSummary,
} from "@/lib/api/types"
import { routeHref } from "@/config/navigation"
import {
  caseStatusMeta,
  findingKindLabel,
  findingSeverityMeta,
  findingStatusMeta,
} from "@/lib/domain"
import { formatDate, toAsciiDigits } from "@/lib/format"
import { fieldIds } from "@/mocks/evidence"
import { reviewKey, useReviewResults } from "@/mocks/reviewStore"
import { useFindingDecisions } from "@/mocks/findingStore"
import { isCurrentSessionLive, useDataSourceKey } from "@/lib/api/session"
import Load from "@/hooks/useLoader"
import Button from "@/components/ui/Button"
import { SelectField, TextField } from "@/components/ui/Field"
import { Page, Panel } from "@/components/ui/Layout"
import { EmptyState, Notice } from "@/components/ui/States"
import StatusBadge from "@/components/ui/StatusBadge"

type Sort = "attention" | "oldest" | "newest"
const attentionOrder = { needs_info: 0, new: 1, in_progress: 2 } as const

function CaseTable({ cases }: { cases: ReviewCaseSummary[] }) {
  const results = useReviewResults()
  const [q, setQ] = useState("")
  const [status, setStatus] = useState("all")
  const [sort, setSort] = useState<Sort>("attention")

  if (cases.length === 0)
    return (
      <EmptyState title="পর্যালোচনার জন্য কোনো মামলা নেই" icon="check">
        নতুন মামলা এলে এখানে দেখাবে।
      </EmptyState>
    )

  const progress = (id: string) =>
    fieldIds.filter((f) => results[reviewKey(id, f)]).length
  const needle = toAsciiDigits(q.trim()).toLowerCase()
  const shown = cases
    .filter((c) => status === "all" || c.status === status)
    .filter(
      (c) =>
        !needle ||
        toAsciiDigits(`${c.reference} ${c.title} ${c.summary}`)
          .toLowerCase()
          .includes(needle),
    )
    .sort((a, b) =>
      sort === "attention"
        ? attentionOrder[a.status] - attentionOrder[b.status] ||
          a.receivedAt.localeCompare(b.receivedAt)
        : sort === "oldest"
          ? a.receivedAt.localeCompare(b.receivedAt)
          : b.receivedAt.localeCompare(a.receivedAt),
    )

  return (
    <>
      <div className="mb-4 grid gap-3 md:grid-cols-[minmax(0,1fr)_14rem_14rem] md:items-end">
        <TextField
          label="মামলা খুঁজুন"
          type="search"
          placeholder="রেফারেন্স, মৌজা বা খতিয়ান"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <SelectField
          label="অবস্থা"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          options={[
            { value: "all", label: "সব অবস্থা" },
            ...Object.entries(caseStatusMeta).map(([value, m]) => ({
              value,
              label: m.label,
            })),
          ]}
        />
        <SelectField
          label="সাজানো"
          value={sort}
          onChange={(e) => setSort(e.target.value as Sort)}
          options={[
            { value: "attention", label: "যাচাই দরকার আগে" },
            { value: "oldest", label: "পুরোনো আগে" },
            { value: "newest", label: "নতুন আগে" },
          ]}
        />
      </div>
      <p role="status" className="mb-2 text-sm text-ink-muted">
        {shown.length.toLocaleString("bn-BD")}টি মামলা দেখানো হচ্ছে
      </p>
      {shown.length === 0 ? (
        <EmptyState title="এই খোঁজে কোনো মামলা মেলেনি" icon="search">
          <Button
            variant="secondary"
            onClick={() => {
              setQ("")
              setStatus("all")
            }}
          >
            খোঁজ মুছুন
          </Button>
        </EmptyState>
      ) : (
        <Panel>
          <ul className="divide-y divide-rule">
            {shown.map((c) => {
              const isLive = isCurrentSessionLive()
              const done = progress(c.id)
              return (
                <li
                  key={c.id}
                  className="relative grid gap-3 px-5 py-4 hover:bg-paper md:grid-cols-[minmax(0,1fr)_12rem_10rem] md:items-center"
                >
                  <div className="min-w-0">
                    <p className="text-sm text-ink-muted" lang="en">
                      {c.reference}
                    </p>
                    <a
                      href={isLive ? routeHref("application", c.id) : routeHref("case", c.id)}
                      className="font-semibold text-ink after:absolute after:inset-0 hover:underline"
                    >
                      {c.title}
                    </a>
                    <p className="text-ink-muted">{c.summary}</p>
                    <p className="mt-1 text-sm">
                      <span className="text-ink-muted">পরের কাজ:</span>{" "}
                      {c.nextAction}
                    </p>
                  </div>
                  <div className="space-y-1">
                    <StatusBadge {...caseStatusMeta[c.status]} />
                    <p className="text-sm text-ink-muted">
                      গ্রহণ {formatDate(c.receivedAt)}
                    </p>
                  </div>
                  <div>
                    {isLive ? (
                      c.parcelId ? (
                        <a
                          href={routeHref("record", c.parcelId)}
                          className="relative z-10 text-xs text-accent underline hover:decoration-accent"
                        >
                          সংযুক্ত জমি দেখুন
                        </a>
                      ) : (
                        <span className="text-xs text-ink-muted">প্রাথমিক আবেদন</span>
                      )
                    ) : (
                      <>
                        <p className="text-sm">
                          {done.toLocaleString("bn-BD")}/
                          {fieldIds.length.toLocaleString("bn-BD")}টি তথ্য দেখা হয়েছে
                        </p>
                        <div
                          className="mt-1 h-2 overflow-hidden rounded-full bg-sunken"
                          aria-hidden="true"
                        >
                          <div
                            className="h-full bg-accent"
                            style={{ width: `${(done / fieldIds.length) * 100}%` }}
                          />
                        </div>
                      </>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        </Panel>
      )}
    </>
  )
}

function FindingTable({ findings }: { findings: Finding[] }) {
  const decisions = useFindingDecisions()
  const [q, setQ] = useState("")
  const [severity, setSeverity] = useState("all")
  const [status, setStatus] = useState("all")
  const [activeFinding, setActiveFinding] = useState<Finding | null>(null)
  const [action, setAction] = useState<FindingReviewAction>("under_review")
  const [reason, setReason] = useState("")
  const [actionError, setActionError] = useState("")
  const [busy, setBusy] = useState(false)
  const [noteMsg, setNoteMsg] = useState("")

  const needle = toAsciiDigits(q.trim()).toLowerCase()
  const shown = findings.filter((f) => {
    const currentStatus = decisions[f.id]?.action ?? f.status
    if (status !== "all" && currentStatus !== status) return false
    if (severity !== "all" && f.severity !== severity) return false
    if (!needle) return true
    const text = `${f.title} ${f.explanation} ${f.ruleCode ?? ""} ${f.evidenceReference ?? ""}`
    return toAsciiDigits(text).toLowerCase().includes(needle)
  })

  const handleReviewClick = (f: Finding) => {
    setActiveFinding(f)
    const existing = decisions[f.id]
    setAction(
      existing?.action ?? (f.status === "open" ? "under_review" : f.status),
    )
    setReason(existing?.reason ?? "")
    setActionError("")
    setNoteMsg("")
  }

  const handleSaveDecision = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!activeFinding) return
    if ((action === "resolved" || action === "dismissed") && !reason.trim()) {
      setActionError("সিদ্ধান্ত মীমাংসা বা খারিজ করতে কারণ/নোট লেখা আবশ্যক।")
      return
    }
    setActionError("")
    setBusy(true)
    try {
      const res = await recordFindingReview({
        findingId: activeFinding.id,
        action,
        reason: reason.trim() || undefined,
        version: activeFinding.version,
      })
      if (res?.finding) {
        activeFinding.status = res.finding.status
        activeFinding.version = res.finding.version
      }
      setNoteMsg(
        `"${activeFinding.title}"-এর জন্য পর্যালোচনা সিদ্ধান্ত সংরক্ষিত হয়েছে।`,
      )
      setActiveFinding(null)
    } catch {
      setActionError("সিদ্ধান্ত সংরক্ষণ করা যায়নি। একটু পর চেষ্টা করুন।")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      {noteMsg && (
        <Notice
          tone="success"
          title="সিদ্ধান্ত আপডেট হয়েছে"
          onDismiss={() => setNoteMsg("")}
        >
          {noteMsg}
        </Notice>
      )}

      <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_12rem_12rem] md:items-end">
        <TextField
          label="পর্যবেক্ষণ খুঁজুন"
          type="search"
          placeholder="শিরোনাম, নিয়ম বা রেফারেন্স"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <SelectField
          label="গুরুত্ব (Severity)"
          value={severity}
          onChange={(e) => setSeverity(e.target.value)}
          options={[
            { value: "all", label: "সব গুরুত্ব" },
            { value: "critical", label: "জরুরি" },
            { value: "high", label: "উচ্চ" },
            { value: "medium", label: "মাঝারি" },
            { value: "low", label: "কম" },
            { value: "info", label: "তথ্যমূলক" },
          ]}
        />
        <SelectField
          label="অবস্থা"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          options={[
            { value: "all", label: "সব অবস্থা" },
            { value: "open", label: "খোলা পর্যবেক্ষণ" },
            { value: "under_review", label: "তদন্তাধীন" },
            { value: "resolved", label: "মীমাংসিত" },
            { value: "dismissed", label: "খারিজ" },
          ]}
        />
      </div>

      <p role="status" className="text-sm text-ink-muted">
        {shown.length.toLocaleString("bn-BD")}টি অসঙ্গতি পর্যবেক্ষণ দেখানো হচ্ছে
      </p>

      {shown.length === 0 ? (
        <EmptyState title="কোনো অসঙ্গতি পর্যবেক্ষণ মেলেনি" icon="check">
          <Button
            variant="secondary"
            onClick={() => {
              setQ("")
              setSeverity("all")
              setStatus("all")
            }}
          >
            ফিল্টার মুছুন
          </Button>
        </EmptyState>
      ) : (
        <Panel>
          <ul className="divide-y divide-rule">
            {shown.map((f) => {
              const currentStatus = decisions[f.id]?.action ?? f.status
              const currentReason = decisions[f.id]?.reason
              const isSelected = activeFinding?.id === f.id
              return (
                <li key={f.id} className="p-5 transition-colors hover:bg-paper">
                  <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <StatusBadge
                          {...findingSeverityMeta[
                            (f.severity as FindingSeverity)
                          ]}
                        />
                        <StatusBadge
                          {...findingStatusMeta[
                            (currentStatus as FindingStatus)
                          ]}
                        />
                        {f.ruleCode && (
                          <span className="rounded-sm bg-sunken px-2 py-0.5 text-xs font-mono font-medium text-ink-muted">
                            {f.ruleCode}
                          </span>
                        )}
                        <span className="text-xs text-ink-muted">
                          {findingKindLabel[f.kind] ?? f.kind}
                        </span>
                      </div>
                      <h3 className="text-base font-semibold text-ink">
                        {f.title}
                      </h3>
                      <p className="max-w-[70ch] text-sm text-ink-muted">
                        {f.explanation}
                      </p>
                      {f.evidenceReference && (
                        <p className="text-xs text-ink-muted">
                          <span className="font-semibold">উৎস রেফারেন্স:</span>{" "}
                          {f.evidenceReference}
                        </p>
                      )}
                      {currentReason && (
                        <p className="rounded-sm bg-sunken/80 px-3 py-1.5 text-xs text-ink">
                          <span className="font-semibold">পর্যালোচকের নোট:</span>{" "}
                          {currentReason}
                        </p>
                      )}
                    </div>

                    <div className="shrink-0 flex flex-col gap-2 sm:flex-row md:flex-col">
                      <Button
                        size="sm"
                        variant={isSelected ? "primary" : "secondary"}
                        onClick={() =>
                          isSelected
                            ? setActiveFinding(null)
                            : handleReviewClick(f)
                        }
                      >
                        {isSelected ? "প্যানেল বন্ধ করুন" : "সিদ্ধান্ত নিন"}
                      </Button>
                      <a
                        href={routeHref("record", f.parcelId)}
                        className="inline-flex min-h-9 items-center justify-center rounded-sm px-2 text-xs text-accent underline decoration-accent/30 hover:decoration-accent"
                      >
                        সংশ্লিষ্ট রেকর্ড দেখুন
                      </a>
                    </div>
                  </div>

                  {isSelected && (
                    <form
                      onSubmit={handleSaveDecision}
                      className="mt-4 rounded-md border border-accent/40 bg-accent-soft/20 p-4 space-y-3"
                    >
                      <h4 className="text-sm font-semibold text-ink">
                        সিদ্ধান্ত লিপিবদ্ধ করুন: {f.title}
                      </h4>
                      <p className="text-xs text-ink-muted">
                        সিদ্ধান্ত শুধুমাত্র এই ট্যাবে সংরক্ষিত হয়। মীমাংসা বা খারিজ করতে কারণ
                        উল্লেখ বাধ্যতামূলক।
                      </p>

                      <div className="flex flex-wrap gap-2">
                        {([
                          "under_review",
                          "resolved",
                          "dismissed",
                        ] as FindingReviewAction[]).map((opt) => (
                          <button
                            key={opt}
                            type="button"
                            onClick={() => {
                              setAction(opt)
                              setActionError("")
                            }}
                            className={`min-h-10 rounded-sm border px-3 py-1 text-sm font-medium transition-colors ${
                              action === opt
                                ? "border-accent bg-accent text-white"
                                : "border-rule bg-surface text-ink hover:bg-sunken"
                            }`}
                          >
                            {opt === "under_review" && "তদন্তাধীন (Under Review)"}
                            {opt === "resolved" && "মীমাংসিত (Resolved)"}
                            {opt === "dismissed" && "খারিজ (Dismissed)"}
                          </button>
                        ))}
                      </div>

                      <TextField
                        label="সিদ্ধান্তের কারণ / পর্যালোচকের মন্তব্য"
                        hint={
                          action === "under_review"
                            ? "ঐচ্ছিক তদন্ত নোট।"
                            : "বাধ্যতামূলক: কেন এই অসঙ্গতিটি মীমাংসা বা খারিজ করা হলো লিখুন।"
                        }
                        value={reason}
                        error={actionError}
                        onChange={(e) => {
                          setReason(e.target.value)
                          if (actionError) setActionError("")
                        }}
                      />

                      <div className="flex flex-wrap gap-2 pt-1">
                        <Button
                          type="submit"
                          size="sm"
                          loading={busy}
                          loadingLabel="সংরক্ষণ হচ্ছে…"
                        >
                          সিদ্ধান্ত সংরক্ষণ করুন
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => setActiveFinding(null)}
                        >
                          বাতিল
                        </Button>
                      </div>
                    </form>
                  )}
                </li>
              )
            })}
          </ul>
        </Panel>
      )}
    </div>
  )
}

export default function QueuePage() {
  const key = useDataSourceKey()
  const [activeTab, setActiveTab] = useState<"cases" | "findings">("cases")

  const loadData = async (signal?: AbortSignal) => {
    const [cases, findings] = await Promise.all([
      fetchReviewCases(signal),
      fetchAllFindings(signal),
    ])
    return { cases, findings }
  }

  return (
    <Page
      title="পর্যালোচনার তালিকা"
      description="যেসব নমুনা রেকর্ড ও অসঙ্গতি পর্যবেক্ষণ মিলিয়ে দেখা দরকার। অবস্থা শুধু ডেমোর কাজের ধাপ বোঝায়; এটি কোনো সরকারি অগ্রাধিকার নয়।"
    >
      <div className="mb-6">
        <Notice tone="info" title="এখানে নেওয়া সিদ্ধান্ত কোনো আনুষ্ঠানিক সরকারি রায় নয়">
          {isCurrentSessionLive()
            ? "আপনার পর্যালোচনা সিদ্ধান্ত ও নোট BhoomiTrace অডিট ট্রেইলে সংরক্ষিত হয়।"
            : "ডেমো মোডে আপনার পর্যালোচনা শুধু এই ব্রাউজার ট্যাবে থাকে এবং পাতা রিফ্রেশ করলে মুছে যায়।"}
        </Notice>
      </div>

      <Load load={loadData} loadKey={`queue-${key}`}>
        {({ cases, findings }) => (
          <div>
            <div
              role="tablist"
              aria-label="পর্যালোচনার ধরন"
              className="mb-6 flex border-b border-rule"
            >
              <button
                type="button"
                role="tab"
                id="tab-cases"
                aria-selected={activeTab === "cases"}
                aria-controls="panel-cases"
                onClick={() => setActiveTab("cases")}
                className={`min-h-12 border-b-2 px-5 text-base font-semibold transition-colors duration-150 ${
                  activeTab === "cases"
                    ? "border-accent text-accent"
                    : "border-transparent text-ink-muted hover:text-ink"
                }`}
              >
                মামলা পর্যালোচনা ({cases.length.toLocaleString("bn-BD")})
              </button>
              <button
                type="button"
                role="tab"
                id="tab-findings"
                aria-selected={activeTab === "findings"}
                aria-controls="panel-findings"
                onClick={() => setActiveTab("findings")}
                className={`min-h-12 border-b-2 px-5 text-base font-semibold transition-colors duration-150 ${
                  activeTab === "findings"
                    ? "border-accent text-accent"
                    : "border-transparent text-ink-muted hover:text-ink"
                }`}
              >
                অসঙ্গতি ও পর্যবেক্ষণ ({findings.length.toLocaleString("bn-BD")})
              </button>
            </div>

            <div
              id={`panel-${activeTab}`}
              role="tabpanel"
              aria-labelledby={`tab-${activeTab}`}
            >
              {activeTab === "cases" ? (
                <CaseTable cases={cases} />
              ) : (
                <FindingTable findings={findings} />
              )}
            </div>
          </div>
        )}
      </Load>
    </Page>
  )
}
