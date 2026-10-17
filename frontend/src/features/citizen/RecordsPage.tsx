import { useState } from "react"
import type { Parcel, RecordSurvey } from "@/lib/api/types"
import { surveyLabel } from "@/lib/domain"
import {
  formatNumber,
  formatShare,
  toAsciiDigits,
  toBengaliDigits,
} from "@/lib/format"
import { routeHref } from "@/config/navigation"
import Button from "@/components/ui/Button"
import { SelectField, TextField } from "@/components/ui/Field"
import { Page, Panel, Term } from "@/components/ui/Layout"
import { EmptyState } from "@/components/ui/States"
import { WithApplicantData, crumbs } from "./shared"

const surveyOptions = [
  { value: "all", label: "সব জরিপ" },
  ...(Object.keys(surveyLabel) as RecordSurvey[]).map((s) => ({
    value: s,
    label: `${surveyLabel[s]} জরিপ`,
  })),
]

function matches(p: Parcel, query: string, survey: string) {
  if (survey !== "all" && p.survey !== survey) return false
  const q = toAsciiDigits(query.trim()).toLowerCase()
  if (!q) return true
  return [p.khatianNumber, p.mouza, ...p.dagNumbers].some((v) =>
    v.toLowerCase().includes(q),
  )
}

export function ParcelSummary({ parcel }: { parcel: Parcel }) {
  const fields: [string, string][] = [
    ["মৌজা ও জেএল", `${parcel.mouza}, জেএল ${toBengaliDigits(parcel.jlNumber)}`],
    ["দাগ", parcel.dagNumbers.map(toBengaliDigits).join(", ")],
    ["মোট জমি", `${formatNumber(parcel.areaDecimal)} শতাংশ`],
    ["রেকর্ডভুক্ত অংশ", formatShare(parcel.ownershipShare)],
    ["জরিপ", `${surveyLabel[parcel.survey]} জরিপ`],
  ]
  return (
    <li className="relative grid gap-3 px-5 py-4 transition-colors duration-150 hover:bg-paper lg:grid-cols-[11rem_minmax(0,1fr)] lg:items-baseline lg:gap-6">
      <h3 className="font-semibold">
        <a
          href={routeHref("record", parcel.id)}
          className="text-accent underline decoration-accent/30 underline-offset-4 after:absolute after:inset-0 hover:decoration-accent"
        >
          খতিয়ান {toBengaliDigits(parcel.khatianNumber)}
        </a>
        <span className="block text-sm font-normal text-ink-muted">
          {parcel.upazila}, {parcel.district}
        </span>
      </h3>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3 lg:grid-cols-5">
        {fields.map(([label, value]) => (
          <div key={label} className="min-w-0">
            <dt className="text-sm text-ink-muted">{label}</dt>
            <dd className="break-words">{value}</dd>
          </div>
        ))}
      </dl>
    </li>
  )
}

export default function RecordsPage() {
  const [query, setQuery] = useState("")
  const [survey, setSurvey] = useState("all")
  const reset = () => {
    setQuery("")
    setSurvey("all")
  }
  return (
    <Page
      title="জমির রেকর্ড"
      breadcrumbs={crumbs("records")}
      description="আপনার নামে যুক্ত খতিয়ান। সব মান কাল্পনিক, কোনো আসল জমি নির্দেশ করে না।"
    >
      <Panel className="mb-6 space-y-1.5 bg-sunken p-4">
        <Term word="খতিয়ান">জমির মালিক, অংশ ও দাগের তালিকা থাকা রেকর্ড।</Term>
        <Term word="দাগ">মৌজার নকশায় প্রতিটি জমির টুকরোর নম্বর।</Term>
        <Term word="রেকর্ডভুক্ত অংশ">
          খতিয়ানে আপনার নামে লেখা ভাগ; মোট জমির পরিমাণ থেকে আলাদা।
        </Term>
      </Panel>
      <WithApplicantData>
        {(data) => {
          if (data.parcels.length === 0)
            return (
              <EmptyState title="কোনো রেকর্ড যুক্ত নেই" icon="map">
                আবেদন অনুমোদিত হলে সংশ্লিষ্ট খতিয়ান এখানে দেখাবে।
              </EmptyState>
            )
          const visible = data.parcels.filter((p) => matches(p, query, survey))
          return (
            <>
              <form
                role="search"
                aria-label="রেকর্ড খুঁজুন"
                className="mb-3 grid gap-3 sm:grid-cols-[minmax(0,1fr)_12rem_auto] sm:items-end"
                onSubmit={(e) => e.preventDefault()}
              >
                <TextField
                  label="খুঁজুন"
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="খতিয়ান, মৌজা বা দাগ"
                  autoComplete="off"
                />
                <SelectField
                  label="জরিপ"
                  value={survey}
                  onChange={(e) => setSurvey(e.target.value)}
                  options={surveyOptions}
                />
                <Button
                  variant="ghost"
                  onClick={reset}
                  disabled={!query && survey === "all"}
                >
                  খোঁজ মুছুন
                </Button>
              </form>
              <p role="status" className="mb-3 text-sm text-ink-muted">
                {formatNumber(data.parcels.length)}টির মধ্যে{" "}
                {formatNumber(visible.length)}টি রেকর্ড দেখানো হচ্ছে
              </p>
              {visible.length === 0 ? (
                <EmptyState
                  title="এই খোঁজে কোনো রেকর্ড মেলেনি"
                  icon="search"
                  action={
                    <Button variant="secondary" onClick={reset}>
                      খোঁজ মুছে সব দেখুন
                    </Button>
                  }
                />
              ) : (
                <ul className="divide-y divide-rule rounded-md border border-rule bg-surface">
                  {visible.map((p) => (
                    <ParcelSummary key={p.id} parcel={p} />
                  ))}
                </ul>
              )}
            </>
          )
        }}
      </WithApplicantData>
    </Page>
  )
}
