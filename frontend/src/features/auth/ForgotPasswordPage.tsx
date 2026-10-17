import { useState } from "react"
import { requestPasswordReset } from "@/lib/api/auth"
import { ApiError } from "@/lib/api/client"
import { routeHref } from "@/hooks/useHashRoute"
import Button, { LinkButton } from "@/components/ui/Button"
import { TextField } from "@/components/ui/Field"
import { Notice } from "@/components/ui/States"
import AuthLayout from "./AuthLayout"

export default function ForgotPasswordPage() {
  const [identifier, setIdentifier] = useState("")
  const [error, setError] = useState("")
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    if (!identifier.trim()) {
      setError("ইমেইল বা ব্যবহারকারী আইডি লিখুন।")
      return
    }
    setError("")
    setNotice(null)
    setBusy(true)
    try {
      await requestPasswordReset(identifier)
      setNotice("অনুরোধ গৃহীত হয়েছে।")
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message)
      } else if (err instanceof Error) {
        setError(err.message)
      } else {
        setError("অনুরোধ প্রক্রিয়াকরণ সম্ভব হয়নি।")
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthLayout
      title="পাসওয়ার্ড পুনরুদ্ধার"
      intro="ভূমিট্রেস সিস্টেমে অ্যাকাউন্ট নিরাপত্তা সংক্রান্ত নির্দেশনা।"
    >
      <div className="space-y-4 rounded-md bg-surface p-5 sm:p-6">
        <Notice tone="info" title="অনলাইন পাসওয়ার্ড রিসেট অপশন নেই">
          ভূমিট্রেস ব্যাকএন্ডে সরাসরি কোনো ইমেইল বা অনলাইন সেলফ-সার্ভিস পাসওয়ার্ড রিসেট
          পদ্ধতি রাখা হয়নি। অ্যাকাউন্টের ক্রেডেনশিয়াল পুনরুদ্ধারের জন্য অনুগ্রহ করে আপনার
          সিস্টেম অ্যাডমিনিস্ট্রেটর অথবা ভূমি অফিস হেল্পডেস্কে যোগাযোগ করুন।
        </Notice>

        {notice ? (
          <Notice tone="success" title="তথ্য">
            {notice}
          </Notice>
        ) : null}

        <form
          noValidate
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
        >
          <TextField
            label="ইমেইল বা ব্যবহারকারী আইডি"
            autoComplete="username"
            value={identifier}
            onChange={(e) => setIdentifier(e.target.value)}
            error={error}
            hint="অ্যাকাউন্টের নির্ধারিত ইমেইল বা ইউজারনেম"
          />

          <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
            <a href={routeHref("login")} className="text-link">
              লগইনে ফিরুন
            </a>
            <Button
              type="submit"
              size="lg"
              loading={busy}
              loadingLabel="যাচাই হচ্ছে…"
            >
              পুনরুদ্ধারের আবেদন
            </Button>
          </div>
        </form>

        <div className="border-t border-border pt-4 text-xs text-muted">
          লোকাল বা অপারেটর পরিবেশের জন্য সিএলআই নির্দেশিকা:
          <code className="mt-1 block rounded bg-surface-subtle p-2 font-mono text-[11px] text-foreground">
            npm run db:admin -- --reset-password
          </code>
        </div>
      </div>
    </AuthLayout>
  )
}
