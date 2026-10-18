import { useId, useRef, useState } from "react"
import type { DocumentItem, DocumentStatus } from "@/lib/api/types"
import { applicationTypeLabel, documentStatusMeta } from "@/lib/domain"
import {
  ALLOWED_UPLOAD_ACCEPT,
  UPLOAD_MAX_LABEL,
  describeUploadError,
  uploadDocument,
  validateUploadFile,
} from "@/lib/api/documents"
import { isCurrentSessionLive } from "@/lib/api/session"
import { toDocumentItem } from "@/lib/api/dashboard"
import { formatDate, formatNumber, toBengaliDigits } from "@/lib/format"
import { routeHref } from "@/config/navigation"
import Button from "@/components/ui/Button"
import { SelectField, TextField } from "@/components/ui/Field"
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

/** "report.pdf" → "report" — a starting title the applicant can edit. */
function titleFromFilename(name: string): string {
  return name.replace(/\.[^.]+$/, "").slice(0, 300)
}

function formatKilobytes(bytes: number): string {
  return `${formatNumber(Math.max(1, Math.round(bytes / 1024)))} কেবি`
}

/**
 * Real, authenticated document upload.
 *
 * The file is posted to `POST /api/v1/documents/upload` with the session cookie
 * and CSRF header attached by the API client, so the same protections that guard
 * every other write apply here. Progress is reported from the upload stream; a
 * failure is described with the server's own reason rather than a generic error.
 */
function UploadPanel({
  onUploaded,
}: {
  onUploaded: (doc: DocumentItem) => void
}) {
  const inputId = useId()
  const [file, setFile] = useState<File | null>(null)
  const [title, setTitle] = useState("")
  const [fileError, setFileError] = useState("")
  const [titleError, setTitleError] = useState("")
  const [uploading, setUploading] = useState(false)
  const [progress, setProgress] = useState<number | null>(null)
  const [failure, setFailure] = useState("")
  const [success, setSuccess] = useState("")
  const abortRef = useRef<AbortController | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  const live = isCurrentSessionLive()

  if (!live) {
    return (
      <Panel className="space-y-3 p-5">
        <h2 className="text-lg font-semibold">নথি আপলোড</h2>
        <Notice tone="info" title="ডেমো মোডে আপলোড বন্ধ">
          আপলোড করা ফাইল সার্ভারে সংরক্ষিত হয়, তাই এটি করতে সাইন ইন করে প্রকৃত
          অ্যাকাউন্টে ঢুকতে হবে। ডেমো মোডে কোনো ফাইল কোথাও পাঠানো হয় না।
        </Notice>
      </Panel>
    )
  }

  const pick = (chosen: File | null) => {
    setFileError("")
    setFailure("")
    setSuccess("")
    setProgress(null)
    if (!chosen) {
      setFile(null)
      return
    }
    const check = validateUploadFile(chosen)
    if (!check.ok) {
      setFile(null)
      setFileError(check.message)
      if (inputRef.current) inputRef.current.value = ""
      return
    }
    setFile(chosen)
    if (!title.trim()) setTitle(titleFromFilename(chosen.name))
  }

  const submit = async () => {
    setFailure("")
    setSuccess("")
    let valid = true
    if (!file) {
      setFileError("একটি ফাইল বেছে নিন।")
      valid = false
    }
    if (!title.trim()) {
      setTitleError("নথির একটি শিরোনাম দিন।")
      valid = false
    }
    if (!valid || !file) return

    const controller = new AbortController()
    abortRef.current = controller
    setUploading(true)
    setProgress(0)
    try {
      const document = await uploadDocument(
        { file, title: title.trim() },
        {
          signal: controller.signal,
          onProgress: (p) =>
            setProgress(
              p.total ? Math.round((p.loaded / p.total) * 100) : null,
            ),
        },
      )
      setSuccess(`“${document.title}” আপলোড হয়েছে।`)
      setFile(null)
      setTitle("")
      setTitleError("")
      onUploaded(toDocumentItem(document))
      if (inputRef.current) inputRef.current.value = ""
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return
      setFailure(describeUploadError(error))
    } finally {
      setUploading(false)
      setProgress(null)
      abortRef.current = null
    }
  }

  return (
    <Panel className="space-y-4 p-5">
      <div>
        <h2 className="text-lg font-semibold">নথি আপলোড</h2>
        <p className="text-ink-muted">
          পিডিএফ, জেপিজি বা পিএনজি ফাইল (সর্বোচ্চ {UPLOAD_MAX_LABEL}) আপনার
          অ্যাকাউন্টে সংরক্ষণ করুন। ফাইলটি ব্যক্তিগত স্টোরেজে রাখা হয় এবং শুধু
          আপনার ও পর্যালোচকেরা দেখতে পারেন।
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor={inputId} className="mb-1.5 block text-sm font-medium">
            ফাইল
          </label>
          <input
            ref={inputRef}
            id={inputId}
            type="file"
            accept={ALLOWED_UPLOAD_ACCEPT}
            disabled={uploading}
            aria-describedby={fileError ? `${inputId}-error` : undefined}
            aria-invalid={fileError ? true : undefined}
            className="block w-full text-base file:mr-3 file:min-h-11 file:cursor-pointer file:rounded-sm file:border file:border-rule-strong file:bg-surface file:px-4 file:text-base file:text-ink hover:file:bg-sunken"
            onChange={(e) => pick(e.target.files?.[0] ?? null)}
          />
          {fileError && (
            <p
              id={`${inputId}-error`}
              role="alert"
              className="mt-1.5 text-sm font-medium text-danger"
            >
              {fileError}
            </p>
          )}
          {file && (
            <p className="mt-1.5 text-sm text-ink-muted">
              <span lang="en" className="break-all">
                {file.name}
              </span>
              , {formatKilobytes(file.size)}
            </p>
          )}
        </div>
        <TextField
          label="নথির শিরোনাম"
          hint="তালিকায় এই নামে দেখাবে"
          value={title}
          error={titleError}
          disabled={uploading}
          onChange={(e) => {
            setTitle(e.target.value)
            setTitleError("")
          }}
        />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button
          onClick={() => void submit()}
          loading={uploading}
          loadingLabel={
            progress === null
              ? "আপলোড হচ্ছে…"
              : `আপলোড হচ্ছে… ${toBengaliDigits(progress)}%`
          }
          icon="upload"
          disabled={!file}
        >
          ফাইল আপলোড করুন
        </Button>
        {uploading && (
          <span role="status" className="text-sm text-ink-muted">
            সংযোগ ধরে রাখুন, পাতা বন্ধ করবেন না।
          </span>
        )}
      </div>

      {success && (
        <Notice tone="success" title="আপলোড সম্পন্ন">
          {success}
        </Notice>
      )}
      {failure && (
        <Notice tone="danger" title="আপলোড ব্যর্থ হয়েছে">
          {failure}
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
  const [justUploaded, setJustUploaded] = useState<DocumentItem[]>([])
  const live = isCurrentSessionLive()

  return (
    <Page
      title="নথিপত্র"
      breadcrumbs={crumbs("documents")}
      description={
        live
          ? "আপনার আপলোড করা ও আবেদনের সঙ্গে যুক্ত নথি। কোনটি জমা বাকি, কোনটি দেখা হচ্ছে।"
          : "আপনার আবেদন ও রেকর্ডের সঙ্গে যুক্ত নমুনা নথি। কোনটি জমা বাকি, কোনটি দেখা হচ্ছে।"
      }
    >
      <div className="space-y-10">
        <WithApplicantData>
          {(data) => {
            const documents = [
              ...justUploaded,
              ...data.documents.filter(
                (d) => !justUploaded.some((u) => u.id === d.id),
              ),
            ]
            if (documents.length === 0)
              return (
                <EmptyState title="কোনো নথি নেই" icon="folder">
                  {live
                    ? "নিচের ফর্ম থেকে নথি আপলোড করুন; সেগুলো এখানে দেখা যাবে।"
                    : "আবেদন করলে সংশ্লিষ্ট নথির তালিকা এখানে দেখাবে।"}
                </EmptyState>
              )
            const related = (d: DocumentItem) => {
              const a = data.applications.find((x) => x.id === d.applicationId)
              const p = data.parcels.find((x) => x.id === d.parcelId)
              return (
                [
                  a &&
                    `${applicationTypeLabel[a.type]} (${a.trackingNumber ?? "খসড়া"})`,
                  p && `খতিয়ান ${toBengaliDigits(p.khatianNumber)}`,
                ]
                  .filter(Boolean)
                  .join(", ") || (live ? "সংযুক্তি তথ্য নেই" : "")
              )
            }
            const visible = documents.filter(
              (d) => filter === "all" || d.status === filter,
            )
            const pending = documents.filter(
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
                  {formatNumber(documents.length)}টির মধ্যে{" "}
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
        <UploadPanel
          onUploaded={(doc) =>
            setJustUploaded((prev) => [
              doc,
              ...prev.filter((d) => d.id !== doc.id),
            ])
          }
        />
      </div>
    </Page>
  )
}
