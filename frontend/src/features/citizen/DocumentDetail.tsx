import { useState } from "react"
import { fetchDocument } from "@/lib/api/dashboard"
import { apiDownload } from "@/lib/api/client"
import type { DocumentItem } from "@/lib/api/types"
import { documentStatusMeta } from "@/lib/domain"
import { formatDate, toBengaliDigits } from "@/lib/format"
import { routeHref } from "@/config/navigation"
import { useRoute } from "@/hooks/useHashRoute"
import Load from "@/hooks/useLoader"
import Button from "@/components/ui/Button"
import { Page, Panel, Section } from "@/components/ui/Layout"
import { Notice } from "@/components/ui/States"
import StatusBadge from "@/components/ui/StatusBadge"
import { crumbs } from "./shared"

/** A drawn, synthetic page. Selecting a field highlights the line it came from. */
function Preview({
  doc,
  selected,
  onSelect,
}: {
  doc: DocumentItem
  selected: string | null
  onSelect: (id: string) => void
}) {
  return (
    <div
      role="group"
      aria-label="কৃত্রিম নথির পাতা"
      className="rounded-md border border-rule bg-folio p-5 sm:p-6"
    >
      <p className="text-center text-sm text-ink-muted">
        নমুনা নথি, পৃষ্ঠা ১ / {toBengaliDigits(doc.pages ?? 1)}
      </p>
      <p className="mt-1 text-center font-display text-lg font-semibold">
        {doc.name}
      </p>
      <div className="mt-4 space-y-1.5 border-t border-rule pt-3">
        {doc.fields.map((f) => (
          <button
            key={f.id}
            type="button"
            onClick={() => onSelect(f.id)}
            aria-pressed={selected === f.id}
            className={`flex w-full justify-between gap-4 rounded-sm border-2 px-2 py-1 text-left transition-colors duration-150 ${
              selected === f.id
                ? "border-warning bg-highlight"
                : "border-transparent hover:border-rule-strong"
            }`}
          >
            <span className="text-ink-muted">{f.label}</span>
            <span className="font-display">{f.value}</span>
          </button>
        ))}
        {/* Filler lines stand for the rest of the page text. */}
        <span
          aria-hidden="true"
          className="mt-3 block h-2 w-11/12 rounded bg-rule"
        />
        <span aria-hidden="true" className="block h-2 w-3/4 rounded bg-rule" />
        <span aria-hidden="true" className="block h-2 w-5/6 rounded bg-rule" />
      </div>
      <p className="mt-4 text-sm text-ink-muted">
        কাল্পনিক নথি। কোনো আসল কাগজের ছবি বা ওসিআর ফল নয়।
      </p>
    </div>
  )
}

function Body({ doc }: { doc: DocumentItem }) {
  const [selected, setSelected] = useState<string | null>(
    doc.fields[0]?.id ?? null,
  )
  const [downloading, setDownloading] = useState(false)
  const [downloadError, setDownloadError] = useState("")
  const field = doc.fields.find((f) => f.id === selected)
  const meta: [string, string][] = [
    ["নথি রেফারেন্স", doc.reference ?? "নেই"],
    ["পৃষ্ঠা", doc.pages ? toBengaliDigits(doc.pages) : "নেই"],
    ["জমার তারিখ", doc.date ? formatDate(doc.date) : "এখনো জমা হয়নি"],
  ]

  const handleDownload = async () => {
    setDownloading(true)
    setDownloadError("")
    try {
      const { blob, filename } = await apiDownload(
        `/api/v1/documents/${doc.id}/file`,
      )
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = filename || doc.originalFilename || `${doc.name}.pdf`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } catch {
      setDownloadError("ফাইল ডাউনলোড করা সম্ভব হয়নি।")
    } finally {
      setDownloading(false)
    }
  }

  return (
    <div className="space-y-8">
      {doc.hasStoredFile ? (
        <Notice tone="info" title="সংরক্ষিত নথি">
          এই নথিটির মূল ফাইল BhoomiTrace সুরক্ষিত ফাইল স্টোরেজে সংরক্ষিত রয়েছে।
        </Notice>
      ) : (
        <Notice tone="info" title="নমুনা বিষয়বস্তু">
          এই নথি ও এর তথ্য প্রদর্শনীমূলক। ডেমোতে কোনো নথি স্ক্যান বা যাচাই করা হয়নি।
        </Notice>
      )}
      <Panel className="flex flex-col gap-4 p-5 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <StatusBadge {...documentStatusMeta[doc.status]} />
          <p className="mt-2 max-w-[60ch]">{doc.note}</p>
          {doc.hasStoredFile && (
            <div className="mt-4">
              <Button
                size="sm"
                variant="secondary"
                loading={downloading}
                loadingLabel="ডাউনলোড হচ্ছে…"
                onClick={handleDownload}
              >
                মূল ফাইল ডাউনলোড করুন{" "}
                {doc.originalFilename ? `(${doc.originalFilename})` : ""}
              </Button>
              {downloadError && (
                <p className="mt-1.5 text-xs text-danger">{downloadError}</p>
              )}
            </div>
          )}
        </div>
        <dl className="grid shrink-0 gap-1 text-sm">
          {meta.map(([k, v]) => (
            <div key={k} className="flex gap-2">
              <dt className="text-ink-muted">{k}:</dt>
              <dd
                lang={k === "নথি রেফারেন্স" && doc.reference ? "en" : undefined}
              >
                {v}
              </dd>
            </div>
          ))}
        </dl>
      </Panel>

      {doc.fields.length === 0 ? (
        <p className="rounded-md bg-surface px-5 py-4 text-ink-muted">
          {doc.status === "requested"
            ? "নথিটি এখনো জমা হয়নি, তাই দেখানোর মতো কিছু নেই।"
            : "এই নথির কোনো তথ্য ডেমোতে দেখানো হয় না।"}
        </p>
      ) : (
        <div className="grid gap-6 lg:grid-cols-2 lg:items-start">
          <Section title="নথির পাতা">
            <Preview doc={doc} selected={selected} onSelect={setSelected} />
          </Section>
          <Section
            title="পড়া তথ্য"
            description="একটি তথ্য বেছে নিলে পাতায় তার জায়গা হলুদ হয়।"
          >
            <ul className="divide-y divide-rule rounded-md border border-rule bg-surface">
              {doc.fields.map((f) => (
                <li key={f.id}>
                  <button
                    type="button"
                    aria-pressed={selected === f.id}
                    onClick={() => setSelected(f.id)}
                    className={`flex w-full items-start justify-between gap-4 px-5 py-3 text-left ${
                      selected === f.id ? "bg-accent-soft" : "hover:bg-sunken"
                    }`}
                  >
                    <span>
                      <span className="block text-sm text-ink-muted">
                        {f.label}
                      </span>
                      <span className="font-semibold">{f.value}</span>
                    </span>
                    {f.unclear && (
                      <StatusBadge tone="warning" icon="alert" label="অস্পষ্ট" />
                    )}
                  </button>
                </li>
              ))}
            </ul>
            {field && (
              <p className="mt-3 text-sm" role="status">
                <span className="text-ink-muted">উৎস:</span> {field.source}
                {field.unclear &&
                  " — এই অংশটি পরিষ্কার পড়া যায়নি; অফিসে মিলিয়ে দেখা দরকার হতে পারে।"}
              </p>
            )}
          </Section>
        </div>
      )}

      <nav aria-label="সংশ্লিষ্ট" className="flex flex-wrap gap-x-6">
        {doc.applicationId && (
          <a
            href={routeHref("application", doc.applicationId)}
            className="text-link"
          >
            সংশ্লিষ্ট আবেদন
          </a>
        )}
        {doc.parcelId && (
          <a href={routeHref("record", doc.parcelId)} className="text-link">
            সংশ্লিষ্ট জমির রেকর্ড
          </a>
        )}
        <a href={routeHref("documents")} className="text-link">
          ← সব নথিতে ফিরুন
        </a>
      </nav>
    </div>
  )
}

export default function DocumentDetailPage() {
  const { param = "" } = useRoute()
  return (
    <Load
      load={(signal) => fetchDocument(param, signal)}
      loadKey={param}
      framed
      notFound={{
        title: "নথিটি পাওয়া যায়নি",
        backHref: routeHref("documents"),
        backLabel: "সব নথি দেখুন",
      }}
    >
      {({ document }) => (
        <Page
          title={document.name}
          breadcrumbs={crumbs("document", document.name)}
        >
          <Body doc={document} />
        </Page>
      )}
    </Load>
  )
}
