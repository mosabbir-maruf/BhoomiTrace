import { useRef, useState } from "react"
import { login } from "@/lib/api/auth"
import { ApiError } from "@/lib/api/client"
import { setSession } from "@/lib/api/session"
import { parseHash, routes } from "@/config/navigation"
import { navigate, routeHref, useRoute } from "@/hooks/useHashRoute"
import { AuthError, demoPersonas } from "@/mocks/auth"
import Button from "@/components/ui/Button"
import { TextField } from "@/components/ui/Field"
import { Notice } from "@/components/ui/States"
import AuthLayout, { PasswordField } from "./AuthLayout"
import DemoEntry from "./DemoEntry"

export default function LoginPage() {
  const { query } = useRoute()
  const next = query.get("next")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [shown, setShown] = useState(false)
  const [errors, setErrors] = useState<{
    email?: string
    password?: string
  }>({})
  const [failure, setFailure] = useState("")
  const [busy, setBusy] = useState(false)
  const [demoInfoOpen, setDemoInfoOpen] = useState(false)
  const formRef = useRef<HTMLFormElement>(null)
  const summaryRef = useRef<HTMLDivElement>(null)

  const submit = async () => {
    if (busy) return
    const found: typeof errors = {}
    if (!email.trim()) found.email = "ইমেইল ঠিকানা লিখুন।"
    if (!password) found.password = "পাসওয়ার্ড লিখুন।"
    setErrors(found)
    setFailure("")
    if (Object.keys(found).length) {
      requestAnimationFrame(() =>
        formRef.current
          ?.querySelector<HTMLInputElement>('[aria-invalid="true"]')
          ?.focus(),
      )
      return
    }
    setBusy(true)
    try {
      const session = await login({ email, password })
      setPassword("")
      setSession(session)
      const target = next ? parseHash(next) : null
      const allowed =
        target &&
        [session.role, "signed-in"].includes(routes[target.id].audience)
      navigate(
        allowed
          ? next!
          : routeHref(session.role === "citizen" ? "dashboard" : "queue"),
        { replace: true },
      )
    } catch (error) {
      if (error instanceof ApiError) {
        setFailure(
          error.status === 401
            ? "ইমেইল বা পাসওয়ার্ড সঠিক নয়।"
            : error.message || "এই মুহূর্তে লগইন করা যাচ্ছে না। একটু পরে আবার চেষ্টা করুন।",
        )
      } else {
        const unknown = error instanceof AuthError
        setFailure(
          unknown
            ? "এই ইমেইল ঠিকানায় কোনো অ্যাকাউন্ট নেই। নতুন অ্যাকাউন্ট তৈরি করুন অথবা ডেমো ব্যবহার করুন।"
            : "এই মুহূর্তে লগইন করা যাচ্ছে না। একটু পরে আবার চেষ্টা করুন।",
        )
        if (unknown) setDemoInfoOpen(true)
      }
      requestAnimationFrame(() => summaryRef.current?.focus())
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthLayout
      title="লগইন করুন"
      intro="আপনার অ্যাকাউন্টে প্রবেশ করে আবেদন ও জমির রেকর্ড দেখুন।"
    >
      {query.get("signedOut") && (
        <Notice tone="success" title="আপনি লগআউট করেছেন" />
      )}
      {query.get("reason") === "required" && (
        <Notice
          tone="info"
          title="এই পাতা দেখতে আগে লগইন করুন বা ডেমোতে প্রবেশ করুন"
        />
      )}

      <form
        ref={formRef}
        noValidate
        aria-labelledby="login-form-h"
        className="space-y-5"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <h2 id="login-form-h" className="sr-only">
          অ্যাকাউন্টে লগইন
        </h2>
        {failure && (
          <div ref={summaryRef} tabIndex={-1} className="outline-none">
            <Notice tone="danger" title="লগইন হয়নি">
              {failure}
            </Notice>
          </div>
        )}
        <TextField
          label="ইমেইল ঠিকানা"
          value={email}
          onChange={(e) => {
            setEmail(e.target.value)
            if (errors.email)
              setErrors((errs) => ({ ...errs, email: undefined }))
            if (failure) setFailure("")
          }}
          error={errors.email}
          autoComplete="email"
          autoCapitalize="none"
          spellCheck={false}
          inputMode="email"
          type="email"
          placeholder="name@example.com"
          className="h-12"
        />
        <div>
          <PasswordField
            label="পাসওয়ার্ড"
            value={password}
            onChange={(val) => {
              setPassword(val)
              if (errors.password)
                setErrors((errs) => ({ ...errs, password: undefined }))
              if (failure) setFailure("")
            }}
            error={errors.password}
            shown={shown}
            onToggle={() => setShown((v) => !v)}
            autoComplete="current-password"
          />
          <div className="mt-1 flex justify-end">
            <a
              href={routeHref("forgot-password")}
              className="text-link text-sm"
            >
              পাসওয়ার্ড ভুলে গেছেন?
            </a>
          </div>
        </div>
        <Button
          type="submit"
          size="lg"
          loading={busy}
          loadingLabel="লগইন হচ্ছে…"
          className="w-full"
        >
          লগইন করুন
        </Button>
        <p className="text-center text-sm text-ink-muted">
          অ্যাকাউন্ট নেই?{" "}
          <a href={routeHref("register")} className="text-link">
            নতুন অ্যাকাউন্ট তৈরি করুন
          </a>
        </p>
      </form>

      <div className="pt-2">
        <DemoEntry />
      </div>

      <details
        open={demoInfoOpen}
        onToggle={(e) => setDemoInfoOpen(e.currentTarget.open)}
        className="group rounded-sm border border-rule bg-surface"
      >
        <summary className="flex min-h-11 items-center justify-between gap-3 px-4 text-sm font-medium text-ink [&::-webkit-details-marker]:hidden">
          ডেমো মোড সংক্রান্ত তথ্য (অফলাইন প্রোটোটাইপ)
          <span
            aria-hidden="true"
            className="text-ink-muted transition-transform duration-150 group-open:rotate-180"
          >
            ▾
          </span>
        </summary>
        <div className="space-y-3 border-t border-rule px-4 py-3 text-sm">
          <p className="text-ink-muted">
            উপরের লগইন ফরমটি সরাসরি BhoomiTrace ব্যাকএন্ড সার্ভারের সাথে সংযুক্ত। আপনার নিবন্ধিত ইমেইল ও পাসওয়ার্ড দিয়ে লগইন করুন।
          </p>
          <p className="text-xs text-ink-muted">
            সার্ভার ছাড়াই প্রোটোটাইপ দেখতে চাইলে ওপরের <span className="font-semibold text-ink">“সরাসরি ডেমো দেখুন”</span> বোতামগুলো ব্যবহার করুন। ডেমো সেশন সম্পূর্ণ ব্রাউজার মেমোরিতে চলে এবং কোনো রিয়েল ব্যাকএন্ড ডেটা পরিবর্তন করে না।
          </p>
        </div>
      </details>
    </AuthLayout>
  )
}
