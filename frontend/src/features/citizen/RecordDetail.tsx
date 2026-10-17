import { useState } from "react"
import { fetchParcel, requestCertifiedCopy } from "@/lib/api/dashboard"
import type { ParcelDetail } from "@/lib/api/types"
import {
  documentStatusMeta,
  findingKindLabel,
  findingSeverityMeta,
  findingStatusMeta,
  surveyLabel,
} from "@/lib/domain"
import { formatNumber, formatShare, toBengaliDigits } from "@/lib/format"
import { routeHref } from "@/config/navigation"
import { useRoute } from "@/hooks/useHashRoute"
import Load from "@/hooks/useLoader"
import Button from "@/components/ui/Button"
import { Page, Panel, Section } from "@/components/ui/Layout"
import { Notice } from "@/components/ui/States"
import StatusBadge from "@/components/ui/StatusBadge"
import { useFindingDecisions } from "@/mocks/findingStore"
import { ApplicationList, crumbs } from "./shared"

function CopyRequest({ parcelId }: { parcelId: string }) {
  const [state, setState] = useState<{ s: "idle" | "loading" | "error" } | {
    s: "done"
    id: string
  }>({ s: "idle" })
  const request = async () => {
    setState({ s: "loading" })
    try {
      const result = await requestCertifiedCopy(parcelId)
      setState({ s: "done", id: result.requestId })
    } catch {
      setState({ s: "error" })
    }
  }
  if (state.s === "done")
    return (
      <Notice tone="success" title={`ডেমো অনুরোধ তৈরি হয়েছে: ${state.id}`}>
        এটি শুধু এই ডেমোর ভেতরে। কোনো ভূমি অফিসে অনুরোধ পাঠানো হয়নি এবং কোনো কপি তৈরি
        হবে না।
      </Notice>
    )
  return (
    <div className="space-y-3">
      <Button
        variant="secondary"
        onClick={request}
        loading={state.s === "loading"}
        loadingLabel="তৈরি হচ্ছে…"
      >
        সার্টিফাইড কপির অনুরোধ (ডেমো)
      </Button>
      {state.s === "error" && (
        <Notice tone="danger" title="অনুরোধ তৈরি করা যায়নি">
          একটু পরে আবার চেষ্টা করুন।
        </Notice>
      )}
    </div>
  )
}

function shareArea(p: ParcelDetail): string | null {
  const [n, d] = p.ownershipShare.split("/").map(Number)
  if (!n || !d) return null
  return formatNumber(Math.round((p.areaDecimal * n * 100) / d) / 100)
}

function ReconciliationAndFindings({ p }: { p: ParcelDetail }) {
  const decisions = useFindingDecisions()
  const rec = p.reconciliation
  const findings = p.findings ?? []

  if (!rec && findings.length === 0) {
    return null
  }

  const statusMeta =
    rec?.summary.outcome === "ready"
      ? {
          tone: "success" as const,
          icon: "check" as const,
          label: "কোনো গরমিল পাওয়া যায়নি — নিয়ম উত্তীর্ণ",
        }
      : rec?.summary.outcome === "needs_review"
        ? {
            tone: "warning" as const,
            icon: "alert" as const,
            label: "কিছু গরমিল বা তারতম্য চিহ্নিত হয়েছে",
          }
        : {
            tone: "danger" as const,
            icon: "alert" as const,
            label: "জরুরি পর্যবেক্ষণ প্রয়োজন",
          }

  return (
    <Section
      title="স্বয়ংক্রিয় নিয়ম ও অসঙ্গতি পর্যবেক্ষণ"
      description="ঐতিহাসিক জরিপ ও নথিপত্রের ভিত্তিতে স্বয়ংক্রিয় যাচাইকরণ। অসঙ্গতি মানেই জালিয়াতি নয়।"
    >
      <div className="space-y-6">
        <Notice tone="info" title="পার্থক্য সংক্রান্ত তথ্য ও দৃষ্টিভঙ্গি">
          এই ফলাফলগুলো কোনো জালিয়াতির অভিযোগ নয়; জমি সংক্রান্ত কোনো গরমিল থাকলে বা বিভিন্ন
          জরিপের স্বাভাবিক পার্থক্যের কারণে তা পর্যালোচনার জন্য চিহ্নিত করা হয়েছে।
        </Notice>

        {rec && (
          <Panel className="space-y-4 p-5">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <p className="text-sm text-ink-muted">স্বয়ংক্রিয় মূল্যায়ন সারাংশ</p>
                <p className="mt-1 font-semibold text-ink">
                  {rec.summary.summary}
                </p>
                <p className="mt-1 text-xs text-ink-muted">
                  নিয়ম সংস্করণ: {toBengaliDigits(rec.rulesVersion)}
                </p>
              </div>
              <StatusBadge {...statusMeta} />
            </div>

            <div className="border-t border-rule pt-4">
              <h4 className="mb-3 text-sm font-semibold text-ink">
                যাচাইকৃত নিয়মসমূহ
              </h4>
              <ul className="divide-y divide-rule rounded-md border border-rule bg-surface">
                {rec.rules.map((rule) => {
                  const passed = rule.outcome === "pass"
                  const ruleTone = passed
                    ? "success" as const
                    : findingSeverityMeta[rule.severity].tone
                  const ruleLabel = passed
                    ? "উত্তীর্ণ"
                    : rule.outcome === "needs_review"
                      ? "পর্যালোচনা দরকার"
                      : "পার্থক্য আছে"
                  return (
                    <li
                      key={rule.ruleCode}
                      className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-start sm:justify-between"
                    >
                      <div className="min-w-0 pr-3">
                        <p className="font-medium text-ink">{rule.title}</p>
                        <p className="text-sm text-ink-muted">
                          {rule.explanation}
                        </p>
                        {(rule.observedValue || rule.expectedValue) && (
                          <p className="mt-1 text-xs text-ink-muted">
                            {rule.observedValue && (
                              <span>
                                পাওয়া মান: <strong>
                                  {rule.observedValue}
                                </strong>{" "}
                              </span>
                            )}
                            {rule.expectedValue && (
                              <span>(প্রত্যাশিত: {rule.expectedValue})</span>
                            )}
                          </p>
                        )}
                      </div>
                      <div className="shrink-0">
                        <StatusBadge
                          tone={ruleTone}
                          icon={passed ? "check" : "alert"}
                          label={ruleLabel}
                        />
                      </div>
                    </li>
                  )
                })}
              </ul>
            </div>
          </Panel>
        )}

        <div>
          <div className="mb-3 flex items-center justify-between">
            <h4 className="text-base font-semibold">
              চিহ্নিত অসঙ্গতি ও পর্যবেক্ষণ ({toBengaliDigits(findings.length)}টি)
            </h4>
            <a href={routeHref("queue")} className="text-sm text-link">
              পর্যালোচক ডেস্কে দেখুন →
            </a>
          </div>

          {findings.length === 0 ? (
            <p className="rounded-md bg-surface px-5 py-4 text-ink-muted">
              এই রেকর্ডের জন্য কোনো অসঙ্গতি নথিভুক্ত নেই।
            </p>
          ) : (
            <ul className="divide-y divide-rule rounded-md border border-rule bg-surface">
              {findings.map((f) => {
                const decision = decisions[f.id]
                const currentStatus = decision?.action ?? f.status
                const statusInfo = findingStatusMeta[currentStatus]
                const severityInfo = findingSeverityMeta[f.severity]
                return (
                  <li key={f.id} className="space-y-2 px-5 py-4">
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-semibold text-ink">
                            {f.title}
                          </span>
                          <span className="rounded bg-paper px-2 py-0.5 text-xs text-ink-muted border border-rule">
                            {findingKindLabel[f.kind]}
                          </span>
                        </div>
                        <p className="mt-1 text-sm text-ink-muted">
                          {f.explanation}
                        </p>
                      </div>
                      <div className="flex flex-wrap items-center gap-2 sm:flex-col sm:items-end">
                        <StatusBadge {...severityInfo} />
                        <StatusBadge {...statusInfo} />
                      </div>
                    </div>
                    {decision?.reason && (
                      <p className="rounded bg-paper px-3 py-1.5 text-xs text-ink">
                        <span className="font-medium text-ink-muted">
                          পর্যালোচকের সিদ্ধান্ত/কারণ:
                        </span>{" "}
                        {decision.reason}
                      </p>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </div>
    </Section>
  )
}

function Body({ p }: { p: ParcelDetail }) {
  const facts: [string, string][] = [
    ["খতিয়ান নম্বর", toBengaliDigits(p.khatianNumber)],
    ["জরিপ", `${surveyLabel[p.survey]} জরিপ`],
    ["দাগ নম্বর", p.dagNumbers.map(toBengaliDigits).join(", ")],
    ["মৌজা", p.mouza],
    ["জেএল নম্বর", toBengaliDigits(p.jlNumber)],
    ["উপজেলা ও জেলা", `${p.upazila}, ${p.district}`],
  ]
  const yours = shareArea(p)
  return (
    <div className="space-y-10">
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
        <Section title="রেকর্ডের তথ্য">
          <Panel>
            <dl className="divide-y divide-rule">
              {facts.map(([k, v]) => (
                <div
                  key={k}
                  className="grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)] gap-4 px-5 py-3"
                >
                  <dt className="text-ink-muted">{k}</dt>
                  <dd>{v}</dd>
                </div>
              ))}
            </dl>
          </Panel>
        </Section>
        <Section title="জমি ও অংশ">
          <Panel className="space-y-4 p-5">
            <div>
              <p className="text-sm text-ink-muted">দাগগুলোর মোট জমি</p>
              <p className="font-display text-2xl font-semibold">
                {formatNumber(p.areaDecimal)} শতাংশ
              </p>
            </div>
            <div>
              <p className="text-sm text-ink-muted">খতিয়ানে আপনার নামে লেখা অংশ</p>
              <p className="font-display text-2xl font-semibold">
                {formatShare(p.ownershipShare)}
              </p>
            </div>
            {yours && p.ownershipShare !== "1/1" && (
              <p className="text-sm text-ink-muted">
                শুধু গাণিতিক হিসাব: {formatNumber(p.areaDecimal)} ×{" "}
                {toBengaliDigits(p.ownershipShare)} ≈ {yours} শতাংশ। এটি মালিকানা বা
                সীমানার কোনো আইনি সিদ্ধান্ত নয়।
              </p>
            )}
            <CopyRequest parcelId={p.id} />
          </Panel>
        </Section>
      </div>

      <ReconciliationAndFindings p={p} />

      <Section
        title="রেকর্ডের ইতিহাস"
        description="বিভিন্ন জরিপে এই জমির নমুনা রেকর্ড"
      >
        {p.history.length === 0 ? (
          <p className="rounded-md bg-surface px-5 py-4 text-ink-muted">
            এই রেকর্ডের কোনো ইতিহাস নমুনায় নেই।
          </p>
        ) : (
          <ol className="divide-y divide-rule rounded-md border border-rule bg-surface">
            {p.history.map((h) => (
              <li
                key={h.survey}
                className="grid gap-2 px-5 py-4 sm:grid-cols-[10rem_minmax(0,1fr)_auto] sm:items-start sm:gap-6"
              >
                <p className="font-semibold">
                  {surveyLabel[h.survey]} জরিপ, {h.year}
                </p>
                <div>
                  <p>
                    খতিয়ান {toBengaliDigits(h.khatianNumber)}, দাগ{" "}
                    {h.dagNumbers.map(toBengaliDigits).join(", ")}
                  </p>
                  <p className="text-sm text-ink-muted">{h.note}</p>
                </div>
                <StatusBadge
                  tone={h.certainty === "sample" ? "success" : "neutral"}
                  icon={h.certainty === "sample" ? "check" : "info"}
                  label={
                    h.certainty === "sample"
                      ? "নমুনা রেকর্ডে আছে"
                      : "উদাহরণ, যাচাই হয়নি"
                  }
                />
              </li>
            ))}
          </ol>
        )}
      </Section>

      <Section title="সংশ্লিষ্ট নথি">
        {p.documents.length === 0 ? (
          <p className="rounded-md bg-surface px-5 py-4 text-ink-muted">
            কোনো নথি যুক্ত নেই।
          </p>
        ) : (
          <ul className="divide-y divide-rule rounded-md border border-rule bg-surface">
            {p.documents.map((d) => (
              <li
                key={d.id}
                className="flex flex-col gap-2 px-5 py-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <a
                  href={routeHref("document", d.id)}
                  className="font-semibold text-accent underline decoration-accent/30 underline-offset-4"
                >
                  {d.name}
                </a>
                <StatusBadge {...documentStatusMeta[d.status]} />
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="সংশ্লিষ্ট আবেদন">
        {p.applications.length === 0 ? (
          <p className="rounded-md bg-surface px-5 py-4 text-ink-muted">
            এই রেকর্ডে কোনো আবেদন নেই।
          </p>
        ) : (
          <ApplicationList applications={p.applications} />
        )}
      </Section>

      <p>
        <a href={routeHref("records")} className="text-link">
          ← সব রেকর্ডে ফিরুন
        </a>
      </p>
    </div>
  )
}

export default function RecordDetailPage() {
  const { param = "" } = useRoute()
  return (
    <Load
      load={(signal) => fetchParcel(param, signal)}
      loadKey={param}
      framed
      notFound={{
        title: "রেকর্ডটি পাওয়া যায়নি",
        backHref: routeHref("records"),
        backLabel: "সব রেকর্ড দেখুন",
      }}
    >
      {(p) => (
        <Page
          title={`খতিয়ান ${toBengaliDigits(p.khatianNumber)}, ${p.mouza}`}
          breadcrumbs={crumbs(
            "record",
            `খতিয়ান ${toBengaliDigits(p.khatianNumber)}`,
          )}
          description="নমুনা রেকর্ডের সারাংশ। এটি কোনো সরকারি খতিয়ান বা সনদ নয়।"
        >
          <Body p={p} />
        </Page>
      )}
    </Load>
  )
}
