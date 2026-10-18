import { useEffect, useRef, useState, type ReactNode } from "react"
import { fetchApplication } from "@/lib/api/dashboard"
import { submitApplication } from "@/lib/api/applications"
import type {
  ApplicationType,
  NewApplicationDraft,
  NewApplicationResult,
} from "@/lib/api/types"
import { applicationTypeLabel } from "@/lib/domain"
import { isCurrentSessionLive } from "@/lib/api/session"
import { toAsciiDigits, toBengaliDigits } from "@/lib/format"
import { routeHref } from "@/config/navigation"
import { navigate, useRoute } from "@/hooks/useHashRoute"
import Load from "@/hooks/useLoader"
import Button, { LinkButton } from "@/components/ui/Button"
import { SelectField, TextField } from "@/components/ui/Field"
import { Page, Panel } from "@/components/ui/Layout"
import { Notice } from "@/components/ui/States"
import { crumbs } from "./shared"

const steps = [
  "আবেদনের ধরন",
  "জমির তথ্য",
  "প্রয়োজনীয় নথি",
  "তথ্য মিলিয়ে দেখুন",
] as const

const typeHelp: Record<ApplicationType, string> = {
  mutation: "জমি কেনা বা উত্তরাধিকারের পর খতিয়ানে নিজের নাম তোলা।",
  record_correction: "খতিয়ানে নাম, অংশ বা পরিমাণে ভুল থাকলে তা ঠিক করার আবেদন।",
  certified_copy: "খতিয়ানের সত্যায়িত কপি পাওয়ার আবেদন।",
}

/* Sample checklist only. Real requirements come from the land office's own instructions. */
const docsFor: Record<ApplicationType, {
  id: string
  label: string
  required: boolean
}[]> = {
  mutation: [
    { id: "deed", label: "দলিলের কপি", required: true },
    { id: "id", label: "পরিচয়পত্রের কপি", required: true },
    { id: "khatian", label: "সর্বশেষ খতিয়ানের কপি", required: true },
    { id: "tax", label: "খাজনা পরিশোধের রসিদ", required: false },
  ],
  record_correction: [
    { id: "id", label: "পরিচয়পত্রের কপি", required: true },
    { id: "khatian", label: "যে খতিয়ানে ভুল আছে তার কপি", required: true },
    { id: "heir", label: "ওয়ারিশ সনদ (প্রযোজ্য হলে)", required: false },
  ],
  certified_copy: [{ id: "id", label: "পরিচয়পত্রের কপি", required: true }],
}

const upazilas: Record<string, string[]> = {
  টাঙ্গাইল: ["মির্জাপুর", "বাসাইল", "কালিহাতী", "সখিপুর"],
  ময়মনসিংহ: ["ত্রিশাল", "ভালুকা", "মুক্তাগাছা"],
  গাজীপুর: ["কালিয়াকৈর", "শ্রীপুর", "কাপাসিয়া"],
  কুমিল্লা: ["চান্দিনা", "দাউদকান্দি", "মুরাদনগর"],
}

const empty: NewApplicationDraft = {
  type: "mutation",
  district: "",
  upazila: "",
  mouza: "",
  khatianNumber: "",
  dagNumber: "",
  areaDecimal: "",
  share: "",
  documents: [],
}

const DRAFT_KEY = "bhoomitrace-demo-draft"

type Errors = Partial<Record<keyof NewApplicationDraft, string>>

function validate(step: number, d: NewApplicationDraft): Errors {
  const e: Errors = {}
  const ascii = (v: string) => toAsciiDigits(v.trim())
  if (step === 1) {
    if (!d.district) e.district = "জেলা বেছে নিন।"
    if (!d.upazila) e.upazila = "উপজেলা বেছে নিন।"
    if (!d.mouza.trim()) e.mouza = "মৌজার নাম লিখুন।"
    if (!/^[0-9]+$/.test(ascii(d.khatianNumber)))
      e.khatianNumber = "শুধু সংখ্যা দিয়ে খতিয়ান নম্বর লিখুন, যেমন ৫৭২।"
    if (!/^[0-9]+$/.test(ascii(d.dagNumber)))
      e.dagNumber = "শুধু সংখ্যা দিয়ে দাগ নম্বর লিখুন, যেমন ১২৪৫।"
    if (d.areaDecimal.trim()) {
      const normDecimal = ascii(d.areaDecimal).replace(/[।,\s]/g, ".")
      const num = Number(normDecimal)
      if (isNaN(num) || num <= 0) {
        e.areaDecimal = "জমির পরিমাণ সংখ্যায় লিখুন, যেমন ১১ বা ০.৫০।"
      }
    }
    if (d.share.trim()) {
      const normShare = ascii(d.share).replace(/[।\s]/g, "")
      if (!/^[0-9]+(\/[0-9]+)?$/.test(normShare)) {
        e.share = "অংশ ভগ্নাংশে লিখুন, যেমন ১/৩, অথবা খালি রাখুন।"
      }
    }
  }
  if (step === 2) {
    const missing = docsFor[d.type].filter(
      (doc) => doc.required && !d.documents.includes(doc.id),
    )
    if (missing.length)
      e.documents = `তালিকায় দরকারি নথিগুলো চিহ্নিত করুন: ${missing.map((m) => m.label).join(", ")}।`
  }
  return e
}

function readSavedDraft(): NewApplicationDraft | null {
  try {
    const raw = sessionStorage.getItem(DRAFT_KEY)
    return raw
      ? { ...empty, ...JSON.parse(raw) as Partial<NewApplicationDraft> }
      : null
  } catch {
    return null
  }
}

function Wizard({
  initial,
  fromDraft,
}: {
  initial: NewApplicationDraft
  fromDraft: string | null
}) {
  const [step, setStep] = useState(0)
  const [draft, setDraft] = useState(initial)
  const [errors, setErrors] = useState<Errors>({})
  const [submitting, setSubmitting] = useState(false)
  const [failed, setFailed] = useState(false)
  const [savedNote, setSavedNote] = useState("")
  const [confirmCancel, setConfirmCancel] = useState(false)
  const [result, setResult] = useState<NewApplicationResult | null>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const errorRef = useRef<HTMLDivElement>(null)
  const firstRender = useRef(true)
  const live = isCurrentSessionLive()

  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false
      return
    }
    headingRef.current?.focus()
  }, [step, result])

  const set = <K extends keyof NewApplicationDraft,>(
    key: K,
    value: NewApplicationDraft[K],
  ) => {
    setSavedNote("")
    setErrors((errs) => {
      if (!errs[key]) return errs
      const { [key]: _c, ...rest } = errs
      return rest
    })
    setDraft((d) => ({ ...d, [key]: value }))
  }
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial)

  const next = () => {
    const found = validate(step, draft)
    setErrors(found)
    if (Object.keys(found).length) {
      requestAnimationFrame(() => errorRef.current?.focus())
      return
    }
    setStep((s) => s + 1)
  }
  const back = () => {
    setErrors({})
    setStep((s) => s - 1)
  }
  const saveDraft = () => {
    try {
      sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft))
      setSavedNote("খসড়াটি শুধু এই ব্রাউজার ট্যাবে রাখা হয়েছে। ট্যাব বন্ধ করলে মুছে যাবে।")
    } catch {
      setSavedNote("এই ব্রাউজারে খসড়া রাখা গেল না।")
    }
  }
  const cancel = () => {
    try {
      sessionStorage.removeItem(DRAFT_KEY)
    } catch {
      /* nothing to clear */
    }
    navigate(routeHref("applications"))
  }
  const submit = async () => {
    setSubmitting(true)
    setFailed(false)
    try {
      const res = await submitApplication(draft)
      try {
        sessionStorage.removeItem(DRAFT_KEY)
      } catch {
        /* ignore */
      }
      setResult(res)
    } catch {
      setFailed(true)
    } finally {
      setSubmitting(false)
    }
  }

  if (result) {
    if (!result.demo) {
      return (
        <Panel className="max-w-2xl space-y-4 p-6">
          <p className="text-sm font-medium text-ink-muted">ধাপ ৫: নিশ্চিতকরণ</p>
          <h2
            ref={headingRef}
            tabIndex={-1}
            className="text-xl font-semibold outline-none text-success"
          >
            আবেদন সফলভাবে দাখিল করা হয়েছে
          </h2>
          <Notice tone="success" title="আপনার আবেদন সার্ভারে রেকর্ড করা হয়েছে">
            আবেদনটি পর্যালোচনার জন্য জমা হয়েছে। ট্র্যাকিং নম্বরের সাহায্যে যেকোনো সময় আপনার
            আবেদনের অগ্রগতি দেখতে পারবেন।
          </Notice>
          <div className="rounded-md border border-rule bg-surface p-4">
            <p className="text-sm text-ink-muted">ট্র্যাকিং নম্বর</p>
            <p
              lang="en"
              className="text-2xl font-bold font-mono text-accent tabular"
            >
              {result.trackingNumber || result.referenceId}
            </p>
          </div>
          <div className="flex flex-wrap gap-3 pt-2">
            {result.applicationId && (
              <LinkButton href={routeHref("application", result.applicationId)}>
                আবেদনের বিস্তারিত দেখুন
              </LinkButton>
            )}
            <LinkButton variant="secondary" href={routeHref("applications")}>
              সব আবেদন দেখুন
            </LinkButton>
            <LinkButton variant="ghost" href={routeHref("dashboard")}>
              ড্যাশবোর্ডে ফিরুন
            </LinkButton>
          </div>
        </Panel>
      )
    }

    return (
      <Panel className="max-w-2xl space-y-4 p-6">
        <p className="text-sm font-medium text-ink-muted">
          ধাপ ৫: ডেমো নিশ্চিতকরণ
        </p>
        <h2
          ref={headingRef}
          tabIndex={-1}
          className="text-xl font-semibold outline-none"
        >
          আপনি আবেদনের সব ধাপ শেষ করেছেন
        </h2>
        <Notice tone="warning" title="এটি শুধু একটি প্রদর্শনী">
          কোনো আবেদন জমা হয়নি। কোনো সরকারি বা অন্য সেবায় কিছু পাঠানো হয়নি, আর তথ্যও
          সংরক্ষণ করা হয়নি। এই আবেদন আপনার তালিকায় যোগ হবে না।
        </Notice>
        <p>
          ডেমো রেফারেন্স:{" "}
          <span lang="en" className="font-semibold tabular">
            {result.referenceId}
          </span>{" "}
          (কাল্পনিক, কোথাও খুঁজে পাওয়া যাবে না)
        </p>
        <div className="flex flex-wrap gap-3">
          <LinkButton href={routeHref("dashboard")}>ড্যাশবোর্ডে ফিরুন</LinkButton>
          <Button
            variant="secondary"
            onClick={() => {
              setDraft(empty)
              setStep(0)
              setResult(null)
            }}
          >
            আরেকটি ডেমো আবেদন
          </Button>
        </div>
      </Panel>
    )
  }

  const errorList = Object.values(errors)
  const docLabels = docsFor[draft.type]
    .filter((d) => draft.documents.includes(d.id))
    .map((d) => d.label)
  const summary: [string, string, number][] = [
    ["আবেদনের ধরন", applicationTypeLabel[draft.type], 0],
    ["জেলা ও উপজেলা", `${draft.district}, ${draft.upazila}`, 1],
    ["মৌজা", draft.mouza, 1],
    ["খতিয়ান নম্বর", toBengaliDigits(draft.khatianNumber), 1],
    ["দাগ নম্বর", toBengaliDigits(draft.dagNumber), 1],
    [
      "জমির পরিমাণ",
      draft.areaDecimal
        ? `${toBengaliDigits(draft.areaDecimal)} শতাংশ`
        : "দেওয়া হয়নি",
      1,
    ],
    ["আপনার অংশ", draft.share ? toBengaliDigits(draft.share) : "দেওয়া হয়নি", 1],
    ["যেসব নথি আছে", docLabels.join(", ") || "কোনোটি চিহ্নিত নয়", 2],
  ]
  const districtOptions = [
    { value: "", label: "বেছে নিন" },
    ...Object.keys(upazilas).map((d) => ({ value: d, label: d })),
  ]
  const upazilaOptions = [
    { value: "", label: draft.district ? "বেছে নিন" : "আগে জেলা বেছে নিন" },
    ...(upazilas[draft.district] ?? []).map((u) => ({ value: u, label: u })),
  ]

  return (
    <div className="max-w-3xl">
      {fromDraft && step === 0 && (
        <div className="mb-5">
          <Notice tone="info" title="আগের খসড়া থেকে চালিয়ে যাচ্ছেন">
            {fromDraft}
          </Notice>
        </div>
      )}
      <ol className="mb-6 grid grid-cols-5 gap-2 text-sm" aria-label="ধাপসমূহ">
        {[...steps, "নিশ্চিতকরণ"].map((label, i) => (
          <li
            key={label}
            aria-current={i === step ? "step" : undefined}
            className="min-w-0"
          >
            <span
              className={`block h-1.5 rounded-full ${
                i <= step ? "bg-accent" : "bg-rule"
              }`}
              aria-hidden="true"
            />
            <span
              className={`mt-1.5 hidden sm:block ${
                i === step
                  ? "font-semibold text-accent"
                  : i < step
                    ? "text-ink"
                    : "text-ink-muted"
              }`}
            >
              {toBengaliDigits(i + 1)}. {label}
            </span>
            <span className="sr-only sm:hidden">
              {toBengaliDigits(i + 1)}. {label}
              {i < step ? " (শেষ)" : ""}
            </span>
          </li>
        ))}
      </ol>

      <Panel className="p-5 sm:p-7">
        <form
          noValidate
          onSubmit={(e) => {
            e.preventDefault()
            if (step === steps.length - 1) void submit()
            else next()
          }}
        >
          <p className="text-sm text-ink-muted">
            মোট ৫ ধাপের ধাপ {toBengaliDigits(step + 1)}
          </p>
          <h2
            ref={headingRef}
            tabIndex={-1}
            className="mb-5 text-xl font-semibold outline-none"
          >
            {steps[step]}
          </h2>

          {errorList.length > 0 && (
            <div className="mb-5 outline-none" ref={errorRef} tabIndex={-1}>
              <Notice tone="danger" title="কিছু তথ্য ঠিক করতে হবে">
                <ul className="list-disc pl-5">
                  {errorList.map((m) => (
                    <li key={m}>{m}</li>
                  ))}
                </ul>
              </Notice>
            </div>
          )}

          {step === 0 && (
            <fieldset className="space-y-3">
              <legend className="sr-only">আবেদনের ধরন বেছে নিন</legend>
              {(Object.keys(typeHelp) as ApplicationType[]).map((t) => (
                <label
                  key={t}
                  className={`flex cursor-pointer gap-3 rounded-md border p-4 ${
                    draft.type === t
                      ? "border-accent bg-accent-soft"
                      : "border-rule hover:bg-sunken"
                  }`}
                >
                  <input
                    type="radio"
                    name="type"
                    checked={draft.type === t}
                    onChange={() =>
                      setDraft((d) => ({ ...d, type: t, documents: [] }))
                    }
                    className="mt-1 size-5 accent-[var(--color-accent)]"
                  />
                  <span>
                    <span className="block font-semibold">
                      {applicationTypeLabel[t]}
                    </span>
                    <span className="block text-ink-muted">{typeHelp[t]}</span>
                  </span>
                </label>
              ))}
            </fieldset>
          )}

          {step === 1 && (
            <div className="grid gap-4 sm:grid-cols-2">
              <SelectField
                label="জেলা"
                value={draft.district}
                error={errors.district}
                options={districtOptions}
                onChange={(e) => {
                  setSavedNote("")
                  setErrors((errs) => {
                    const { district: _d, upazila: _u, ...rest } = errs
                    return rest
                  })
                  setDraft((d) => ({
                    ...d,
                    district: e.target.value,
                    upazila: "",
                  }))
                }}
              />
              <SelectField
                label="উপজেলা"
                value={draft.upazila}
                error={errors.upazila}
                options={upazilaOptions}
                disabled={!draft.district}
                onChange={(e) => set("upazila", e.target.value)}
              />
              <TextField
                label="মৌজা"
                hint="জরিপে এলাকার নাম, সাধারণত গ্রামের নাম"
                value={draft.mouza}
                error={errors.mouza}
                onChange={(e) => set("mouza", e.target.value)}
              />
              <TextField
                label="খতিয়ান নম্বর"
                hint="খতিয়ানের ওপরে লেখা নম্বর"
                inputMode="numeric"
                value={draft.khatianNumber}
                error={errors.khatianNumber}
                onChange={(e) => set("khatianNumber", e.target.value)}
              />
              <TextField
                label="দাগ নম্বর"
                hint="নকশায় জমির টুকরোর নম্বর"
                inputMode="numeric"
                value={draft.dagNumber}
                error={errors.dagNumber}
                onChange={(e) => set("dagNumber", e.target.value)}
              />
              <TextField
                label="জমির পরিমাণ, শতাংশে (ঐচ্ছিক)"
                hint="১০০ শতাংশ = ১ একর"
                inputMode="decimal"
                value={draft.areaDecimal}
                error={errors.areaDecimal}
                onChange={(e) => set("areaDecimal", e.target.value)}
              />
              <TextField
                label="আপনার অংশ (ঐচ্ছিক)"
                hint="খতিয়ানে লেখা অংশ, যেমন ১/৩"
                value={draft.share}
                error={errors.share}
                onChange={(e) => set("share", e.target.value)}
                containerClassName="sm:col-span-2 sm:max-w-[calc(50%-0.5rem)]"
              />
            </div>
          )}

          {step === 2 && (
            <fieldset aria-describedby="docs-hint">
              <legend className="font-medium">কোন নথিগুলো আপনার কাছে আছে?</legend>
              <p id="docs-hint" className="mb-3 text-sm text-ink-muted">
                তারকা (*) চিহ্নিতগুলো এই তালিকায় দরকারি।{" "}
                {live
                  ? "এখানে শুধু নথির তালিকা চিহ্নিত করা হয়; ফাইল আপলোড নথিপত্র পাতা থেকে করা যায়।"
                  : "আসল নিয়ম জানতে ভূমি অফিসের নির্দেশনা দেখুন। ডেমোতে ফাইল আপলোড হয় না।"}
              </p>
              <div className="space-y-2">
                {docsFor[draft.type].map((doc) => (
                  <label
                    key={doc.id}
                    className="flex min-h-12 cursor-pointer items-center gap-3 rounded-md border border-rule px-4 hover:bg-sunken"
                  >
                    <input
                      type="checkbox"
                      className="size-5 accent-[var(--color-accent)]"
                      checked={draft.documents.includes(doc.id)}
                      onChange={(e) => {
                        setSavedNote("")
                        setErrors((errs) => {
                          const { documents: _docs, ...rest } = errs
                          return rest
                        })
                        setDraft((d) => ({
                          ...d,
                          documents: e.target.checked
                            ? [...d.documents, doc.id]
                            : d.documents.filter((x) => x !== doc.id),
                        }))
                      }}
                    />
                    {doc.label}
                    {doc.required && <span aria-label="দরকারি">*</span>}
                  </label>
                ))}
              </div>
            </fieldset>
          )}

          {step === 3 && (
            <>
              <p className="mb-3">
                জমা দেওয়ার আগে তথ্যগুলো দেখে নিন। ভুল থাকলে “বদলান” চাপুন।
              </p>
              <dl className="divide-y divide-rule rounded-md border border-rule">
                {summary.map(([k, v, s]) => (
                  <div
                    key={k}
                    className="grid grid-cols-[minmax(0,8rem)_minmax(0,1fr)_auto] items-center gap-3 px-4 py-2.5"
                  >
                    <dt className="text-ink-muted">{k}</dt>
                    <dd className="break-words">{v}</dd>
                    <dd>
                      <button
                        type="button"
                        className="text-link text-sm"
                        onClick={() => {
                          setErrors({})
                          setStep(s)
                        }}
                      >
                        বদলান<span className="sr-only">: {k}</span>
                      </button>
                    </dd>
                  </div>
                ))}
              </dl>
              {failed && (
                <div className="mt-4">
                  <Notice
                    tone="danger"
                    title={live ? "আবেদন জমা দেওয়া যায়নি" : "ডেমো সম্পন্ন করা যায়নি"}
                  >
                    আপনার তথ্য এখানেই আছে। আবার চেষ্টা করুন।
                  </Notice>
                </div>
              )}
            </>
          )}

          {savedNote && (
            <div className="mt-5">
              <Notice tone="success" title="খসড়া রাখা হয়েছে">
                {savedNote}
              </Notice>
            </div>
          )}

          {confirmCancel ? (
            <div
              className="mt-7 rounded-md bg-warning-soft p-4"
              role="alertdialog"
              aria-labelledby="cancel-q"
            >
              <p id="cancel-q" className="font-semibold">
                আবেদন বাতিল করবেন? লেখা তথ্য মুছে যাবে।
              </p>
              <div className="mt-3 flex flex-wrap gap-3">
                <Button variant="secondary" onClick={cancel}>
                  হ্যাঁ, বাতিল করুন
                </Button>
                <Button onClick={() => setConfirmCancel(false)} autoFocus>
                  না, চালিয়ে যান
                </Button>
              </div>
            </div>
          ) : (
            <div className="mt-7 flex flex-wrap items-center justify-between gap-3 border-t border-rule pt-5">
              <div className="flex flex-wrap gap-2">
                {step > 0 && (
                  <Button variant="secondary" icon="arrowLeft" onClick={back}>
                    আগের ধাপ
                  </Button>
                )}
                <Button variant="ghost" onClick={saveDraft}>
                  খসড়া রাখুন
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => (dirty ? setConfirmCancel(true) : cancel())}
                >
                  বাতিল
                </Button>
              </div>
              <Button
                type="submit"
                size="lg"
                loading={submitting}
                loadingLabel={live ? "জমা হচ্ছে…" : "সম্পন্ন হচ্ছে…"}
              >
                {step === steps.length - 1
                  ? live
                    ? "আবেদন জমা দিন"
                    : "ডেমো আবেদন সম্পন্ন করুন"
                  : "পরের ধাপ"}
              </Button>
            </div>
          )}
        </form>
      </Panel>
    </div>
  )
}

export default function NewApplication() {
  const { id, param } = useRoute()
  const frame = (children: ReactNode) => (
    <Page
      title={id === "continue-application" ? "খসড়া আবেদন" : "নতুন আবেদন"}
      breadcrumbs={crumbs(id)}
      description={
        isCurrentSessionLive()
          ? "ধাপে ধাপে তথ্য দিন। শেষ ধাপে আবেদন সার্ভারে জমা হবে।"
          : "ধাপে ধাপে তথ্য দিন। এটি ডেমো; শেষে কিছুই কোথাও জমা হবে না।"
      }
    >
      {children}
    </Page>
  )

  if (id === "continue-application" && param)
    return frame(
      <Load
        load={(signal) => fetchApplication(param, signal)}
        loadKey={param}
        notFound={{
          title: "খসড়াটি পাওয়া যায়নি",
          backHref: routeHref("applications"),
          backLabel: "সব আবেদন দেখুন",
        }}
      >
        {(app) => (
          <Wizard
            fromDraft={`${app.mouza} মৌজার দাগ ${toBengaliDigits(app.dagNumber)}-এর খসড়া। আগে দেওয়া তথ্য ভরা আছে।`}
            initial={{
              ...empty,
              type: app.type,
              district: app.district,
              upazila: app.upazila,
              mouza: app.mouza,
              khatianNumber: toBengaliDigits(app.khatianNumber),
              dagNumber: toBengaliDigits(app.dagNumber),
            }}
          />
        )}
      </Load>,
    )

  const saved = readSavedDraft()
  return frame(
    <Wizard
      initial={saved ?? empty}
      fromDraft={saved ? "এই ট্যাবে রাখা খসড়া থেকে তথ্য ভরা হয়েছে।" : null}
    />,
  )
}
