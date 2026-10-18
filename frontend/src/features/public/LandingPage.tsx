import { useEffect } from "react"
import Brand from "@/components/shell/Brand"
import SiteFooter from "@/components/shell/SiteFooter"
import { LinkButton } from "@/components/ui/Button"
import Icon from "@/components/ui/Icon"
import { routeHref } from "@/hooks/useHashRoute"

const steps = [
  ["নথি খুলুন", "পুরোনো খতিয়ান বা দলিলের একটি নমুনা পাতা দেখুন।"],
  [
    "তথ্য মিলিয়ে দেখুন",
    "খতিয়ান, দাগ, পরিমাণের মতো তথ্যে ক্লিক করলে নথির কোন জায়গা থেকে এসেছে তা চিহ্নিত হয়।",
  ],
  [
    "সিদ্ধান্ত লিখুন",
    "তথ্যটি ঠিক আছে, সংশোধন দরকার, নাকি আরও পর্যালোচনা দরকার, তা লিখে রাখুন।",
  ],
]

const preview = [
  ["খতিয়ান নম্বর", "১০৪"],
  ["দাগ নম্বর", "৩৪১"],
  ["জমির পরিমাণ", "০.৫০ একর"],
]

export default function LandingPage() {

  return (
    <div className="flex min-h-dvh flex-col">
      <a
        href="#main"
        onClick={(event) => {
          event.preventDefault()
          document.getElementById("main")?.focus()
        }}
        className="fixed top-2 left-2 z-50 -translate-y-[200%] rounded-sm bg-ink px-4 py-2 font-medium text-white focus:translate-y-0"
      >
        মূল বিষয়বস্তুতে যান
      </a>
      <header className="bg-surface">
        <div className="page-width flex min-h-16 flex-wrap items-center justify-between gap-x-6 gap-y-2 py-2">
          <Brand />
          <nav aria-label="ডেমো" className="flex gap-1 text-base">
            <a
              href={routeHref("enter", "citizen")}
              className="inline-flex min-h-11 items-center rounded-sm px-3 transition-colors duration-150 hover:bg-sunken"
            >
              নাগরিক ডেমো
            </a>
            <a
              href={routeHref("enter", "reviewer")}
              className="inline-flex min-h-11 items-center rounded-sm px-3 transition-colors duration-150 hover:bg-sunken"
            >
              পর্যালোচক ডেমো
            </a>
            <a
              href={routeHref("login")}
              className="inline-flex min-h-11 items-center rounded-sm border border-rule-strong px-3 transition-colors duration-150 hover:bg-sunken"
            >
              লগইন
            </a>
          </nav>
        </div>
      </header>

      <main id="main" tabIndex={-1} className="flex-1 outline-none">
        <section className="page-width grid items-center gap-10 py-14 md:py-20 lg:grid-cols-[1.15fr_1fr] lg:gap-14">
          <div>
            <h1 className="font-display text-[1.75rem] leading-[1.35] font-semibold text-ink min-[400px]:text-[2rem] sm:text-[2.75rem] xl:text-[3.5rem]">
              {/* Each clause holds its own line, so the headline is always two lines. */}
              <span className="block whitespace-nowrap">
                পুরোনো ভূমি নথি বুঝুন,
              </span>
              <span className="block whitespace-nowrap">
                রেকর্ডের তথ্য মিলিয়ে দেখুন।
              </span>
            </h1>
            <p className="mt-5 max-w-[48ch] text-lg text-ink-muted">
              নথি থেকে পড়া প্রতিটি তথ্যের পাশে দেখা যায় সেটি নথির কোথা থেকে এসেছে। তারপর
              একজন মানুষ যাচাই করে সিদ্ধান্ত নেন।
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-3">
              <LinkButton href={routeHref("enter", "citizen")} size="lg">
                ডেমো দেখুন
              </LinkButton>
              <a href={routeHref("enter", "reviewer")} className="text-link">
                পর্যালোচকের ডেমো
              </a>
            </div>
            <p className="mt-5 text-sm text-ink-muted">
              এটি একটি স্বাধীন প্রোটোটাইপ। সব তথ্য কাল্পনিক, কোনো সরকারি সেবার সঙ্গে যুক্ত
              নয়।
            </p>
          </div>

          <figure
            data-ui
            className="rounded-md bg-surface p-4 shadow-[0_1px_2px_rgb(29_43_37/0.06),0_12px_32px_-12px_rgb(29_43_37/0.18)] sm:p-6"
          >
            <div className="grid gap-4 sm:grid-cols-[1fr_1fr]">
              <div className="rounded-sm border border-rule bg-folio p-4">
                <p className="text-center text-sm text-ink-muted">
                  নমুনা খতিয়ান, আরএস জরিপ ১৯৮৮
                </p>
                <dl className="mt-3 space-y-2 font-display">
                  <div className="flex justify-between gap-2 border-b border-rule pb-2">
                    <dt>মৌজা</dt>
                    <dd>শালবন</dd>
                  </div>
                  <div className="flex justify-between gap-2 border-b border-rule pb-2">
                    <dt>খতিয়ান</dt>
                    <dd>১০৪</dd>
                  </div>
                  <div className="flex justify-between gap-2 border-b border-rule pb-2">
                    <dt>দাগ</dt>
                    <dd>৩৪১</dd>
                  </div>
                  <div className="flex justify-between gap-2 rounded-sm bg-highlight px-1.5 outline-2 outline-warning">
                    <dt>পরিমাণ</dt>
                    <dd>০.৫০ একর</dd>
                  </div>
                </dl>
              </div>
              <div>
                <p className="mb-2 text-sm font-medium text-ink-muted">
                  পড়া তথ্য
                </p>
                <ul className="divide-y divide-rule rounded-sm border border-rule">
                  {preview.map(([k, v], i) => (
                    <li
                      key={k}
                      className={`px-3 py-2 ${
                        i === 2 ? "bg-warning-soft" : ""
                      }`}
                    >
                      <span className="block text-sm text-ink-muted">{k}</span>
                      <span className="font-semibold">{v}</span>
                      {i === 2 && (
                        <span className="block text-sm text-warning">
                          পর্যালোচনা দরকার
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
            <figcaption className="mt-3 text-sm text-ink-muted">
              হলুদ চিহ্ন দেখায় নির্বাচিত তথ্যটি নথির কোন অংশ থেকে নেওয়া।
            </figcaption>
          </figure>
        </section>

        <section aria-labelledby="steps-h" className="bg-surface py-16">
          <div className="page-width">
            <h2 id="steps-h" className="font-display text-2xl font-semibold">
              যেভাবে কাজ করে
            </h2>
            <ol className="mt-6 grid gap-6 md:grid-cols-3">
              {steps.map(([title, text], i) => (
                <li key={title} className="flex gap-4">
                  <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-full bg-accent font-semibold text-white">
                    {(i + 1).toLocaleString("bn-BD")}
                  </span>
                  <div>
                    <h3 className="text-lg font-semibold">{title}</h3>
                    <p className="mt-1 text-ink-muted">{text}</p>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section aria-labelledby="scope-h" className="page-width py-16">
          <h2 id="scope-h" className="font-display text-2xl font-semibold">
            কী পারে, কী পারে না
          </h2>
          <div className="mt-6 grid gap-6 md:grid-cols-2">
            <div className="rounded-md bg-success-soft p-6">
              <h3 className="flex items-center gap-2 text-lg font-semibold text-success">
                <Icon name="check" />
                যা দেখায়
              </h3>
              <ul className="mt-3 list-disc space-y-1.5 pl-5">
                <li>নথির প্রতিটি তথ্য আর তার উৎসের জায়গা</li>
                <li>বিভিন্ন জরিপের রেকর্ডে একই তথ্যের পার্থক্য</li>
                <li>নাগরিকের আবেদন, করণীয় আর নথির তালিকা</li>
              </ul>
            </div>
            <div className="rounded-md bg-warning-soft p-6">
              <h3 className="flex items-center gap-2 text-lg font-semibold text-warning">
                <Icon name="alert" />
                যা করে না
              </h3>
              <ul className="mt-3 list-disc space-y-1.5 pl-5">
                <li>জমির আইনি মালিকানা ঠিক করে না</li>
                <li>রেকর্ডে পার্থক্য দেখলে তাকে জালিয়াতি বলে না</li>
                <li>কোনো আবেদন বা ফাইল সরকারি অফিসে পাঠায় না</li>
              </ul>
            </div>
          </div>
        </section>
      </main>

      <SiteFooter />
    </div>
  )
}
