import { useRef, useState } from "react"
import { register } from "@/lib/api/auth"
import { ApiError } from "@/lib/api/client"
import { setSession } from "@/lib/api/session"
import type { Session } from "@/lib/api/types"
import { routeHref } from "@/hooks/useHashRoute"
import Button, { LinkButton } from "@/components/ui/Button"
import { TextField } from "@/components/ui/Field"
import { Notice } from "@/components/ui/States"
import AuthLayout, { PasswordField, isEmail } from "./AuthLayout"

const registerStory = {
  title: "জমির কাজ শুরু করুন এক জায়গা থেকে",
  body: "অ্যাকাউন্ট খুলে আবেদন, জমির তথ্য ও নথির অবস্থা সহজে দেখুন।",
}

type Field = "displayName" | "email" | "password" | "confirm" | "consent"

export default function RegisterPage() {
  const [form, setForm] = useState({
    displayName: "",
    email: "",
    password: "",
    confirm: "",
  })
  const [consent, setConsent] = useState(false)
  const [shown, setShown] = useState(false)
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({})
  const [failure, setFailure] = useState("")
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<Session | null>(null)
  const summaryRef = useRef<HTMLDivElement>(null)
  const set = (k: keyof typeof form) => (v: string) => {
    setErrors((errs) => {
      if (!errs[k]) return errs
      const { [k]: _c, ...rest } = errs
      return rest
    })
    setFailure("")
    setForm((f) => ({ ...f, [k]: v }))
  }

  const submit = async () => {
    const e: Partial<Record<Field, string>> = {}
    if (form.displayName.trim().length < 1)
      e.displayName = "আপনার নাম লিখুন।"
    if (!isEmail(form.email))
      e.email = "সঠিক ইমেইল ঠিকানা লিখুন, যেমন name@example.com।"
    if (form.password.length < 12)
      e.password = "পাসওয়ার্ড অন্তত ১২ অক্ষরের হতে হবে (নিরাপত্তা নীতি অনুযায়ী)।"
    if (form.confirm !== form.password) e.confirm = "দুটি পাসওয়ার্ড মেলেনি।"
    if (!consent) e.consent = "এগিয়ে যেতে শর্তে সম্মতি দিন।"
    setErrors(e)
    setFailure("")
    if (Object.keys(e).length) {
      requestAnimationFrame(() => summaryRef.current?.focus())
      return
    }
    setBusy(true)
    try {
      const session = await register({
        displayName: form.displayName.trim(),
        email: form.email.trim(),
        password: form.password,
      })
      setForm((f) => ({ ...f, password: "", confirm: "" }))
      setSession(session)
      setDone(session)
    } catch (error) {
      if (error instanceof ApiError) {
        if (error.status === 409) {
          setFailure("এই ইমেইল ঠিকানায় আগেই একটি অ্যাকাউন্ট নিবন্ধিত আছে। লগইন করুন।")
        } else {
          setFailure(
            error.message ||
              "এই মুহূর্তে অ্যাকাউন্ট তৈরি করা যাচ্ছে না। একটু পরে আবার চেষ্টা করুন।",
          )
        }
      } else {
        setFailure(
          error instanceof Error
            ? error.message
            : "এই মুহূর্তে অ্যাকাউন্ট তৈরি করা যাচ্ছে না। একটু পরে আবার চেষ্টা করুন।",
        )
      }
      requestAnimationFrame(() => summaryRef.current?.focus())
    } finally {
      setBusy(false)
    }
  }

  if (done)
    return (
      <AuthLayout title="অ্যাকাউন্ট তৈরি হয়েছে" story={registerStory}>
        <div className="space-y-4 rounded-md bg-surface p-6">
          <Notice tone="success" title={`স্বাগতম, ${done.displayName}`}>
            {done.isDemo
              ? "অ্যাকাউন্টটি ডেমো মোডে তৈরি হয়েছে।"
              : "আপনার BhoomiTrace অ্যাকাউন্ট সফলভাবে তৈরি হয়েছে।"}
          </Notice>
          <div className="space-y-1 text-sm text-ink-muted">
            <p>
              অ্যাকাউন্টের ভূমিকা:{" "}
              <span className="font-semibold text-ink">
                আবেদনকারী (Applicant)
              </span>
            </p>
            <p>
              ইমেইল:{" "}
              <span lang="en" className="font-semibold text-ink">
                {done.email}
              </span>
            </p>
          </div>
          <LinkButton href={routeHref("dashboard")} size="lg">
            ড্যাশবোর্ডে যান
          </LinkButton>
        </div>
      </AuthLayout>
    )

  const errorList = Object.values(errors)
  return (
    <AuthLayout
      title="নতুন অ্যাকাউন্ট"
      intro="ডেমো ব্যবহারের জন্য একটি অস্থায়ী অ্যাকাউন্ট তৈরি করুন।"
      story={registerStory}
    >
      <form
        noValidate
        className="space-y-4 rounded-md bg-surface p-5 sm:p-6"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        {(errorList.length > 0 || failure) && (
          <div ref={summaryRef} tabIndex={-1} className="outline-none">
            <Notice
              tone="danger"
              title={failure ? "অ্যাকাউন্ট তৈরি হয়নি" : "কিছু তথ্য ঠিক করতে হবে"}
            >
              {failure || (
                <ul className="list-disc pl-5">
                  {errorList.map((m) => (
                    <li key={m}>{m}</li>
                  ))}
                </ul>
              )}
            </Notice>
          </div>
        )}
        <TextField
          label="আপনার নাম (পূর্ণ বা প্রদর্শনের নাম)"
          autoComplete="name"
          placeholder="যেমন: রহিমা বেগম"
          value={form.displayName}
          onChange={(e) => set("displayName")(e.target.value)}
          error={errors.displayName}
        />
        <TextField
          label="ইমেইল ঠিকানা"
          type="email"
          autoComplete="email"
          placeholder="name@example.com"
          value={form.email}
          onChange={(e) => set("email")(e.target.value)}
          error={errors.email}
        />
        <PasswordField
          label="পাসওয়ার্ড"
          hint="কমপক্ষে ১২ অক্ষর। সুরক্ষার স্বার্থে জটিল পাসওয়ার্ড ব্যবহার করুন।"
          value={form.password}
          onChange={set("password")}
          error={errors.password}
          shown={shown}
          onToggle={() => setShown((v) => !v)}
          autoComplete="new-password"
        />
        <PasswordField
          label="পাসওয়ার্ড আবার লিখুন"
          value={form.confirm}
          onChange={set("confirm")}
          error={errors.confirm}
          shown={shown}
          onToggle={() => setShown((v) => !v)}
          autoComplete="new-password"
        />
        <div>
          <label className="flex cursor-pointer gap-3">
            <input
              type="checkbox"
              checked={consent}
              onChange={(e) => {
                setConsent(e.target.checked)
                if (e.target.checked) {
                  setErrors((errs) => {
                    const { consent: _c, ...rest } = errs
                    return rest
                  })
                }
              }}
              aria-invalid={errors.consent ? true : undefined}
              aria-describedby={errors.consent ? "consent-error" : undefined}
              className="mt-1 size-5 shrink-0 accent-[var(--color-accent)]"
            />
            <span>
              আমি প্ল্যাটফর্মের ব্যবহারবিধি ও তথ্য সুরক্ষা নীতিমালার সাথে একমত।
            </span>
          </label>
          {errors.consent && (
            <p
              id="consent-error"
              className="mt-1.5 text-sm font-medium text-danger"
            >
              {errors.consent}
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-rule pt-4">
          <a href={routeHref("login")} className="text-link">
            বাতিল, লগইনে ফিরুন
          </a>
          <Button
            type="submit"
            size="lg"
            loading={busy}
            loadingLabel="তৈরি হচ্ছে…"
          >
            অ্যাকাউন্ট তৈরি করুন
          </Button>
        </div>
      </form>
      <p>
        আগেই অ্যাকাউন্ট আছে?{" "}
        <a href={routeHref("login")} className="text-link">
          লগইন করুন
        </a>
      </p>
    </AuthLayout>
  )
}
