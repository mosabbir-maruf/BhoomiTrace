import { useId, useState } from "react"
import type { DocumentItem, DocumentStatus } from "@/lib/api/types"
import { applicationTypeLabel, documentStatusMeta } from "@/lib/domain"
import { formatDate, formatNumber, toBengaliDigits } from "@/lib/format"
import { routeHref } from "@/config/navigation"
import Button from "@/components/ui/Button"
import { SelectField } from "@/components/ui/Field"
import { Page, Panel, Section } from "@/components/ui/Layout"
import { EmptyState, Notice } from "@/components/ui/States"
import StatusBadge from "@/components/ui/StatusBadge"
import { WithApplicantData, crumbs } from "./shared"

const filterOptions = [
  { value: "all", label: "সব নথি" },
  ...(Object.keys(documentStatusMeta) as DocumentStatus[]).map((s) => ({
    value: s,
    label: documentStatusMeta[s].label,
  })),
]

const MAX_BYTES = 10 * 1024 * 1024
const ALLOWED = ["application/pdf", "image/jpeg", "image/png"]

/** Picks a file for display only. The file never leaves this browser tab and is not read or processed. */
function LocalPicker() {
  const inputId = useId()
  const [file, setFile] = useState<{ name: string; size: number } | null>(null)
  const [error, setError] = useState("")
  return (
    <Panel className="space-y-3 p-5">
      <h2 className="text-lg font-semibold">নমুনা ফাইল বেছে দেখুন</h2>
      <p className="text-ink-muted">
        ফাইল কোনো সার্ভারে পাঠানো হয় না, কোনো সরকারি রেকর্ডে যুক্ত হয় না, আর এতে কোনো লেখা পড়া
        (ওসিআর) হয় না। পাতা বদলালে মুছে যায়।
      </p>
      <div>
        <label htmlFor={inputId} className="mb-1.5 block text-sm font-medium">
          ফাইল (পিডিএফ, জেপিজি বা পিএনজি, ১০ এমবি পর্যন্ত)
        </label>
        <input
          id={inputId}
          type="file"
          accept=".pdf,.jpg,.jpeg,.png"
          aria-describedby={error ? `${inputId}-error` : undefined}
          aria-invalid={error ? true : undefined}
          className="block w-full text-base file:mr-3 file:min-h-11 file:cursor-pointer file:rounded-sm file:border file:border-rule-strong file:bg-surface file:px-4 file:text-base file:text-ink hover:file:bg-sunken"
          onChange={(e) => {
            const f = e.target.files?.[0]
            e.target.value = ""
            if (!f) return
            if (!ALLOWED.includes(f.type)) {
              setError(
                "এই ধরনের ফাইল নেওয়া যায় না। পিডিএফ, জেপিজি বা পিএনজি বেছে নিন।",
              )
              setFile(null)
            } else if (f.size > MAX_BYTES) {
              setError("ফাইলটি ১০ এমবির বেশি বড়।")
              setFile(null)
            } else {
              setError("")
              setFile({ name: f.name, size: f.size })
            }
          }}
        />
        {error && (
          <p
            id={`${inputId}-error`}
            className="mt-1.5 text-sm font-medium text-danger"
          >
            {error}
          </p>
        )}
      </div>
      {file && (
        <Notice
          tone="info"
          title="ফাইল বেছে নেওয়া হয়েছে (শুধু এই ট্যাবে)"
          onDismiss={() => setFile(null)}
        >
          <span lang="en" className="break-all">
            {file.name}
          </span>
          , {formatNumber(Math.max(1, Math.round(file.size / 1024)))} কেবি। কোথাও
          জমা হয়নি।
        </Notice>
      )}
    </Panel>
  )
}

function DocRow({ d, related }: { d: DocumentItem; related: string }) {
  const reviewNeeded = d.fields.some((f) => f.unclear)
  return (
    <li className="relative grid gap-3 px-5 py-4 transition-colors duration-150 hover:bg-paper md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_auto] md:items-start md:gap-6">
      <div className="min-w-0">
        <a
          href={routeHref("document", d.id)}
          className="font-semibold text-accent underline decoration-accent/30 underline-offset-4 after:absolute after:inset-0 hover:decoration-accent"
        >
          {d.name}
        </a>
        <p className="text-sm text-ink-muted">{related}</p>
      </div>
      <div className="text-sm">
        {d.date ? (
          <>
            <p>{formatDate(d.date)}</p>
            <p lang="en" className="text-ink-muted">
              {d.reference}
            </p>
          </>
        ) : (
          <p className="text-ink-muted">এখনো জমা হয়নি</p>
        )}
      </div>
      <div className="flex flex-wrap gap-2 md:flex-col md:items-end">
        <StatusBadge {...documentStatusMeta[d.status]} />
        {reviewNeeded && (
          <StatusBadge tone="warning" icon="alert" label="কিছু তথ্য অস্পষ্ট" />
        )}
      </div>
    </li>
  )
}

export default function DocumentsPage() {
  const [filter, setFilter] = useState("all")
  return (
    <Page
      title="নথিপত্র"
      breadcrumbs={crumbs("documents")}
      description="আপনার আবেদন ও রেকর্ডের সঙ্গে যুক্ত নমুনা নথি। কোনটি জমা বাকি, কোনটি দেখা হচ্ছে।"
    >
      <div className="space-y-10">
        <WithApplicantData>
          {(data) => {
            if (data.documents.length === 0)
              return (
                <EmptyState title="কোনো নথি নেই" icon="folder">
                  আবেদন করলে সংশ্লিষ্ট নথির তালিকা এখানে দেখাবে।
                </EmptyState>
              )
            const related = (d: DocumentItem) => {
              const a = data.applications.find((x) => x.id === d.applicationId)
              const p = data.parcels.find((x) => x.id === d.parcelId)
              return [
                a &&
                  `${applicationTypeLabel[a.type]} (${a.trackingNumber ?? "খসড়া"})`,
                p && `খতিয়ান ${toBengaliDigits(p.khatianNumber)}`,
              ]
                .filter(Boolean)
                .join(", ")
            }
            const visible = data.documents.filter(
              (d) => filter === "all" || d.status === filter,
            )
            const pending = data.documents.filter(
              (d) => d.status === "requested",
            ).length
            return (
              <Section
                title={
                  pending ? `${formatNumber(pending)}টি নথি জমা বাকি` : "সব নথি"
                }
              >
                <div className="mb-3 max-w-xs">
                  <SelectField
                    label="অবস্থা অনুযায়ী দেখুন"
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                    options={filterOptions}
                  />
                </div>
                <p role="status" className="mb-3 text-sm text-ink-muted">
                  {formatNumber(data.documents.length)}টির মধ্যে{" "}
                  {formatNumber(visible.length)}টি নথি
                </p>
                {visible.length === 0 ? (
                  <EmptyState
                    title="এই অবস্থার কোনো নথি নেই"
                    icon="search"
                    action={
                      <Button
                        variant="secondary"
                        onClick={() => setFilter("all")}
                      >
                        সব নথি দেখুন
                      </Button>
                    }
                  />
                ) : (
                  <ul className="divide-y divide-rule rounded-md border border-rule bg-surface">
                    {visible.map((d) => (
                      <DocRow key={d.id} d={d} related={related(d)} />
                    ))}
                  </ul>
                )}
              </Section>
            )
          }}
        </WithApplicantData>
        <LocalPicker />
      </div>
    </Page>
  )
}
