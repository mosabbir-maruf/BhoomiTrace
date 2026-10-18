import { startDemo } from "@/lib/api/session"
import { navigate, routeHref } from "@/hooks/useHashRoute"
import Button from "@/components/ui/Button"

/** One-click entry to either demo with a synthetic persona. Clearly separate from account login. */
export default function DemoEntry() {
  const go = (role: "citizen" | "reviewer") => {
    startDemo(role)
    navigate(routeHref(role === "citizen" ? "dashboard" : "queue"))
  }
  return (
    <section aria-labelledby="demo-entry-h">
      <div className="flex items-center gap-3">
        <span className="h-px flex-1 bg-rule" aria-hidden="true" />
        <h2 id="demo-entry-h" className="text-sm text-ink-muted">
          অথবা সরাসরি ডেমো দেখুন
        </h2>
        <span className="h-px flex-1 bg-rule" aria-hidden="true" />
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <Button variant="secondary" icon="user" onClick={() => go("citizen")}>
          নাগরিক ডেমো
        </Button>
        <Button
          variant="secondary"
          icon="search"
          onClick={() => go("reviewer")}
        >
          পর্যালোচক ডেমো
        </Button>
      </div>
      <p className="mt-2 text-xs text-ink-muted">
        অ্যাকাউন্ট লাগবে না; একজন কাল্পনিক ব্যবহারকারী হিসেবে ঢুকবেন।
      </p>
    </section>
  )
}
