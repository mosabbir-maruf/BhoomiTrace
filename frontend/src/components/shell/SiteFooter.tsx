import { routeHref } from "@/hooks/useHashRoute"
import { isLiveData } from "@/lib/api/session"
import { formatDate } from "@/lib/format"
import { DEMO_TODAY } from "@/mocks/data"
import type { RouteId } from "@/config/navigation"

const groups: { title: string; links: [string, RouteId][] }[] = [
  {
    title: "নাগরিকের জন্য",
    links: [
      ["আমার ড্যাশবোর্ড", "dashboard"],
      ["নতুন আবেদন", "new-application"],
      ["লগইন বা নতুন অ্যাকাউন্ট", "login"],
    ],
  },
  {
    title: "পর্যালোচকের জন্য",
    links: [
      ["পর্যালোচনার তালিকা", "queue"],
      ["রেকর্ড মিলিয়ে দেখা", "compare"],
    ],
  },
  {
    title: "সহায়তা",
    links: [
      ["সাধারণ প্রশ্ন", "help"],
      ["খতিয়ান, দাগ, মৌজার অর্থ", "help"],
    ],
  },
]

/** Brand footer on a deep survey-green field, shared by the landing page and the app. */
export default function SiteFooter() {
  return (
    <footer className="footer-field bg-accent text-white">
      <div className="page-width grid gap-10 pt-12 pb-8 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1.9fr)] lg:gap-16">
        <div>
          <a
            href="#/"
            className="inline-flex items-center gap-2.5 rounded-sm py-1"
            aria-label="BhoomiTrace, প্রথম পাতা"
          >
            <svg
              viewBox="0 0 32 32"
              className="size-9 shrink-0"
              aria-hidden="true"
              focusable="false"
            >
              <rect width="32" height="32" rx="7" fill="#fff" />
              <path
                d="M8 22 11.5 9 23 11 25 21 15 25Z"
                fill="none"
                stroke="var(--color-accent)"
                strokeWidth="2"
                strokeLinejoin="round"
              />
            </svg>
            <span lang="en" className="text-xl font-semibold">
              BhoomiTrace
            </span>
          </a>
          <p className="mt-4 max-w-[30ch] font-display text-xl leading-snug font-semibold text-balance">
            প্রতিটি দাগের হদিস, প্রতিটি রেকর্ডের যাচাই।
          </p>
          <p lang="en" className="mt-1 text-sm text-white/75">
            Trace Every Parcel. Verify Every Record.
          </p>
        </div>

        <nav
          aria-label="ফুটার"
          className="grid grid-cols-2 gap-x-6 gap-y-8 sm:grid-cols-3"
        >
          {groups.map((group) => (
            <div key={group.title}>
              <h2 className="text-sm font-semibold text-white/75">
                {group.title}
              </h2>
              <ul className="mt-2">
                {group.links.map(([label, route]) => (
                  <li key={label}>
                    <a
                      href={routeHref(route)}
                      className="inline-flex min-h-11 items-center underline-offset-4 hover:underline"
                    >
                      {label}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
      </div>

      <div className="bg-[#174a3a]">
        <div className="page-width flex flex-col gap-2 py-5 text-sm text-white/85 md:flex-row md:items-start md:justify-between md:gap-10">
          <p className="max-w-[70ch]">
            <strong className="font-semibold text-white">
              স্বাধীন প্রোটোটাইপ, সরকারি সেবা নয়।
            </strong>{" "}
            সব নাম, নম্বর ও নথি কাল্পনিক। কোনো আবেদন বা সিদ্ধান্ত কোথাও পাঠানো বা সংরক্ষণ করা
            হয় না।
          </p>
          {!isLiveData && (
            <p className="shrink-0">
              ডেমোর আজকের তারিখ: {formatDate(DEMO_TODAY)}
            </p>
          )}
        </div>
      </div>
    </footer>
  )
}
