import { routeHref } from "@/config/navigation"
import { navigate, useRoute } from "@/hooks/useHashRoute"
import { formatNumber, toAsciiDigits } from "@/lib/format"
import {
  fieldIds,
  fieldLabels,
  isUnclear,
  reviewCases,
  sourceRef,
  surveyNames,
  syntheticRecords,
  versionIds,
  type VersionId,
} from "@/mocks/evidence"
import { SelectField } from "@/components/ui/Field"
import Icon from "@/components/ui/Icon"
import { Page, Panel, Section } from "@/components/ui/Layout"
import { Notice } from "@/components/ui/States"
import { isCurrentSessionLive } from "@/lib/api/session"

const isVersion = (v: string | null): v is VersionId =>
  !!v && (versionIds as string[]).includes(v)

/** "০.৫০ একর" → 0.5; null if the value is unreadable. */
function acres(value: string): number | null {
  const n = parseFloat(toAsciiDigits(value))
  return Number.isFinite(n) ? n : null
}
/** "৮ আনা / ১৬ আনা" → 0.5 */
function shareFraction(value: string): number | null {
  const m = toAsciiDigits(value).match(/(\d+)\s*আনা\s*\/\s*(\d+)/)
  return m && Number(m[2]) > 0 ? Number(m[1]) / Number(m[2]) : null
}

function Arithmetic({ a, b }: { a: VersionId; b: VersionId }) {
  const ra = syntheticRecords[a]
  const rb = syntheticRecords[b]
  const areaA = acres(ra.values.area)
  const areaB = acres(rb.values.area)
  const rows: { label: string; value: string }[] = []
  if (areaA !== null && areaB !== null) {
    const diff = areaB - areaA
    rows.push({
      label: "জমির পরিমাণের পার্থক্য",
      value:
        diff === 0
          ? "কোনো পার্থক্য নেই"
          : `${
              diff > 0 ? "+" : "−"
            }${formatNumber(Math.abs(diff))} একর (${formatNumber(Math.abs(diff) * 100)} শতাংশ)`,
    })
  }
  for (const r of [ra, rb]) {
    const area = acres(r.values.area)
    const share = shareFraction(r.values.share)
    rows.push({
      label: `${surveyNames[r.id]}: অংশ অনুযায়ী হিসাব`,
      value:
        area !== null && share !== null
          ? `${formatNumber(area)} × ${formatNumber(share)} = ${formatNumber(area * share)} একর`
          : "অংশ অস্পষ্ট, হিসাব করা যায়নি",
    })
  }
  return (
    <Section
      title="হিসাব যাচাই"
      description="শুধু পাটিগণিত। এটি মালিকানার আইনি সিদ্ধান্ত নয়।"
    >
      <Panel>
        <dl className="divide-y divide-rule">
          {rows.map((r) => (
            <div
              key={r.label}
              className="grid gap-1 px-5 py-3 sm:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]"
            >
              <dt className="text-ink-muted">{r.label}</dt>
              <dd className="font-medium">{r.value}</dd>
            </div>
          ))}
        </dl>
      </Panel>
    </Section>
  )
}

export default function ComparePage() {
  const { query } = useRoute()
  const fromCase = reviewCases.find((c) => c.id === query.get("case"))
  const a: VersionId = isVersion(query.get("a"))
    ? query.get("a") as VersionId
    : (fromCase?.compareWith ?? "SA")
  const b: VersionId = isVersion(query.get("b"))
    ? query.get("b") as VersionId
    : (fromCase?.record ?? "RS")
  const ra = syntheticRecords[a]
  const rb = syntheticRecords[b]
  const diffCount = fieldIds.filter((f) => ra.values[f] !== rb.values[f]).length

  const setVersions = (next: { a: VersionId; b: VersionId }) => {
    const q: Record<string, string> = { a: next.a, b: next.b }
    if (fromCase) q.case = fromCase.id
    navigate(routeHref("compare", undefined, q), { replace: true })
  }
  const options = versionIds.map((v) => ({
    value: v,
    label: `${surveyNames[v]} (${syntheticRecords[v].year})`,
  }))
  const crumbs = fromCase
    ? [
        { label: "পর্যালোচনার তালিকা", href: routeHref("queue") },
        { label: fromCase.reference, href: routeHref("case", fromCase.id) },
        { label: "মিলিয়ে দেখা" },
      ]
    : [
        { label: "পর্যালোচনার তালিকা", href: routeHref("queue") },
        { label: "রেকর্ড মিলিয়ে দেখা" },
      ]

  return (
    <Page
      title="রেকর্ড মিলিয়ে দেখা"
      breadcrumbs={crumbs}
      description="দুটি জরিপের রেকর্ড পাশাপাশি। আলাদা মান চিহ্নিত থাকে; পার্থক্য মানেই ভুল বা জালিয়াতি নয়।"
    >
      <div className="space-y-8">
        <Notice tone="info" title="ডেমো মোড — কাল্পনিক তুলনামূলক বিশ্লেষণ">
          এই জরিপভিত্তিক তুলনামূলক বিশ্লেষণ স্ক্রিনটি প্রোটোটাইপ প্রদর্শনীমূলক এবং কাল্পনিক নমুনা ডেটা ব্যবহার করছে।
          {isCurrentSessionLive() && " সরাসরি ব্যাকএন্ডের জমির রেকর্ড দেখতে জমির রেকর্ড তালিকা বা পর্যালোচনার কার্যতালিকা ব্যবহার করুন।"}
        </Notice>
        <div className="grid gap-3 sm:grid-cols-2 lg:max-w-2xl">
          <SelectField
            label="আগের রেকর্ড"
            value={a}
            onChange={(e) => setVersions({ a: e.target.value as VersionId, b })}
            options={options}
          />
          <SelectField
            label="পরের রেকর্ড"
            value={b}
            onChange={(e) => setVersions({ a, b: e.target.value as VersionId })}
            options={options}
          />
        </div>
        {a === b && (
          <Notice tone="info" title="একই রেকর্ড দুই পাশে বেছে নেওয়া হয়েছে" />
        )}

        <Section title={`পার্থক্য: ${diffCount.toLocaleString("bn-BD")}টি তথ্য`}>
          <Panel className="overflow-x-auto">
            <table className="w-full min-w-[40rem] text-left">
              <caption className="sr-only">
                {surveyNames[a]} ও {surveyNames[b]} রেকর্ডের তুলনা
              </caption>
              <thead className="border-b border-rule bg-paper text-sm text-ink-muted">
                <tr>
                  <th scope="col" className="px-4 py-3 font-medium">
                    তথ্য
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    {surveyNames[a]} {ra.year}
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    {surveyNames[b]} {rb.year}
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    ফলাফল
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-rule">
                {fieldIds.map((f) => {
                  const va = ra.values[f]
                  const vb = rb.values[f]
                  const unclear = isUnclear(va) || isUnclear(vb)
                  const differs = va !== vb
                  return (
                    <tr key={f} className={differs ? "bg-warning-soft/60" : ""}>
                      <th scope="row" className="px-4 py-3 font-medium">
                        {fieldLabels[f]}
                      </th>
                      <td className="px-4 py-3">
                        {va}
                        <span className="block text-xs text-ink-muted">
                          {sourceRef(ra, f)}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        {vb}
                        <span className="block text-xs text-ink-muted">
                          {sourceRef(rb, f)}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <span className="inline-flex items-center gap-1.5">
                          <Icon
                            name={
                              unclear ? "alert" : differs ? "info" : "check"
                            }
                            className="size-4"
                          />
                          {unclear ? "পড়া অস্পষ্ট" : differs ? "আলাদা" : "মিলেছে"}
                        </span>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </Panel>
        </Section>

        <Arithmetic a={a} b={b} />

        <p className="flex flex-wrap gap-x-6 gap-y-2">
          {fromCase && (
            <a className="text-link" href={routeHref("case", fromCase.id)}>
              নথি যাচাইয়ে ফিরুন
            </a>
          )}
          <a
            className="text-link"
            href={routeHref(
              "lineage",
              undefined,
              fromCase ? { case: fromCase.id } : undefined,
            )}
          >
            রেকর্ডের ধারা দেখুন
          </a>
        </p>
      </div>
    </Page>
  )
}
