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
              <rect width="32" height="32" rx="7.5" fill="#ffffff" />
              <path
                d="M6 24 L11 7 L26 9.5 L23 25.5 Z"
                fill="none"
                stroke="var(--color-accent)"
                strokeWidth="1"
                strokeOpacity="0.3"
                strokeLinejoin="round"
              />
              <circle
                cx="26"
                cy="9.5"
                r="1.8"
                fill="#f59e0b"
              />
              <path
                d="M7 9 H13 C15.5 9 17.2 10.3 17.2 12.5 C17.2 14.1 16.2 15.1 14.6 15.6 C16.6 16 17.8 17.5 17.8 19.6 C17.8 22.2 15.6 23.5 13 23.5 H7 Z M10.2 11.8 V14.6 H12.8 C13.9 14.6 14.5 14 14.5 13.2 C14.5 12.3 13.9 11.8 12.8 11.8 Z M10.2 17.3 V20.7 H13 C14.3 20.7 15.1 20.1 15.1 18.9 C15.1 17.8 14.3 17.3 13 17.3 Z"
                fill="var(--color-accent)"
              />
              <path
                d="M18.2 11.5 H25.2 V14.3 H23 V23.5 H20.4 V14.3 H18.2 Z"
                fill="#10b981"
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
