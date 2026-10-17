import { useState } from "react"
import {
  applicationStatusExplain,
  applicationStatusMeta,
  applicationStatusOrder,
} from "@/lib/domain"
import { toAsciiDigits } from "@/lib/format"
import { routeHref } from "@/config/navigation"
import { TextField } from "@/components/ui/Field"
import { Page, Panel, Section } from "@/components/ui/Layout"
import StatusBadge from "@/components/ui/StatusBadge"
import { crumbs } from "./shared"

const terms: [string, string][] = [
  ["খতিয়ান", "জমির মালিক, মালিকানার অংশ আর দাগের তালিকা থাকা রেকর্ড।"],
  ["দাগ", "মৌজার নকশায় প্রতিটি জমির টুকরোর নম্বর।"],
  ["মৌজা", "জরিপের জন্য ভাগ করা একটি এলাকা, সাধারণত একটি গ্রাম বা তার অংশ।"],
  ["জেএল নম্বর", "উপজেলার ভেতরে প্রতিটি মৌজার ক্রমিক নম্বর।"],
  ["নামজারি", "জমি কেনা বা উত্তরাধিকারের পর খতিয়ানে নতুন মালিকের নাম তোলা।"],
  ["জমির পরিমাণ", "দাগ বা খতিয়ানের মোট জমি, সাধারণত শতাংশ বা একরে। ১০০ শতাংশ = ১ একর।"],
  [
    "মালিকানার অংশ",
    "খতিয়ানে একজনের নামে লেখা ভাগ, যেমন ১/৩। এটি মোট জমির পরিমাণ থেকে আলাদা।",
  ],
  [
    "সিএস, এসএ, আরএস, বিএস",
    "বিভিন্ন সময়ের জমি জরিপ। একই জমির নম্বর জরিপভেদে আলাদা হতে পারে।",
  ],
]

const faqs: [string, string][] = [
  [
    "এখানে কি সত্যিকারের আবেদন করা যায়?",
    "না। এটি একটি স্বাধীন প্রোটোটাইপ। সব তথ্য কাল্পনিক, আর কোনো আবেদন কোথাও পাঠানো হয় না।",
  ],
  [
    "লগইন কি আসল?",
    "না। ডেমোতে কোনো পরিচয় যাচাই হয় না এবং পাসওয়ার্ড সংরক্ষণ হয় না। আসল জাতীয় পরিচয়পত্রের তথ্য দেবেন না।",
  ],
  [
    "শেষ তারিখ পেরিয়ে গেলে কী হবে?",
    "ডেমোতে আবেদনটি “সময় পেরিয়ে গেছে” হিসেবে দেখায়। বাস্তবে কী করতে হবে তা সংশ্লিষ্ট ভূমি অফিস থেকে জেনে নিন।",
  ],
  [
    "শুনানির দিন কী আনতে হয়?",
    "ডেমোতে করণীয় তালিকায় একটি নমুনা তালিকা দেখানো আছে। আসল প্রয়োজনীয় কাগজ জানতে ভূমি অফিসের নোটিশ দেখুন।",
  ],
  [
    "দুই রেকর্ডে পার্থক্য মানে কি জালিয়াতি?",
    "না। জরিপভেদে নম্বর বদলানো বা লেখার ভুল স্বাভাবিক। পার্থক্য শুধু মিলিয়ে দেখার প্রশ্ন তোলে, কোনো সিদ্ধান্ত নয়।",
  ],
  [
    "নথিতে দেওয়া চেকলিস্ট কি আসল নিয়ম?",
    "না, এটি নমুনা। প্রকৃত নিয়ম ও প্রয়োজনীয় কাগজের জন্য সরকারি নির্দেশনা দেখুন।",
  ],
]

const guide: [string, string][] = [
  ["ড্যাশবোর্ড দেখুন", "“এখন আপনার করণীয়” অংশে কোন কাজ কবে শেষ করতে হবে তা দেখায়।"],
  ["আবেদন খুলুন", "যেকোনো আবেদনে ক্লিক করলে তার অবস্থা, ইতিহাস ও দরকারি নথি দেখবেন।"],
  ["নতুন আবেদন করুন", "চার ধাপে তথ্য দিয়ে শেষে মিলিয়ে দেখুন। ডেমোতে কিছুই জমা হয় না।"],
  [
    "রেকর্ড ও নথি দেখুন",
    "জমির রেকর্ডে খতিয়ান, দাগ ও অংশ; নথিপত্রে কোন নথি জমা বাকি তা দেখায়।",
  ],
]

export default function HelpPage() {
  const [q, setQ] = useState("")
  const needle = toAsciiDigits(q.trim())
  const shown = faqs.filter(
    ([question, answer]) =>
      !needle || question.includes(needle) || answer.includes(needle),
  )
  return (
    <Page
      title="সহায়তা"
      breadcrumbs={crumbs("help")}
      description="ডেমো কীভাবে ব্যবহার করবেন, সাধারণ প্রশ্ন, শব্দের অর্থ আর অবস্থার লেবেলের মানে।"
    >
      <div className="space-y-12">
        <Section title="ডেমো যেভাবে ব্যবহার করবেন">
          <ol className="grid gap-4 md:grid-cols-2">
            {guide.map(([title, text], i) => (
              <li key={title} className="flex gap-4 rounded-md bg-surface p-5">
                <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-full bg-accent font-semibold text-white">
                  {(i + 1).toLocaleString("bn-BD")}
                </span>
                <div>
                  <h3 className="font-semibold">{title}</h3>
                  <p className="text-ink-muted">{text}</p>
                </div>
              </li>
            ))}
          </ol>
        </Section>

        <div className="grid gap-10 lg:grid-cols-2">
          <Section title="সাধারণ প্রশ্ন">
            <div className="mb-3">
              <TextField
                label="প্রশ্ন খুঁজুন"
                type="search"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="যেমন: শুনানি, লগইন"
              />
            </div>
            <p role="status" className="mb-2 text-sm text-ink-muted">
              {shown.length.toLocaleString("bn-BD")}টি প্রশ্ন
            </p>
            <div className="space-y-2">
              {shown.map(([question, answer]) => (
                <details
                  key={question}
                  className="rounded-md border border-rule bg-surface"
                >
                  <summary className="flex min-h-12 items-center px-4 font-medium">
                    {question}
                  </summary>
                  <p className="border-t border-rule px-4 py-3">{answer}</p>
                </details>
              ))}
              {shown.length === 0 && (
                <p className="rounded-md bg-surface px-4 py-3 text-ink-muted">
                  এই শব্দে কোনো প্রশ্ন মেলেনি।
                </p>
              )}
            </div>
          </Section>
          <Section title="শব্দের অর্থ">
            <Panel>
              <dl className="divide-y divide-rule">
                {terms.map(([t, d]) => (
                  <div key={t} className="px-4 py-3">
                    <dt className="font-semibold">{t}</dt>
                    <dd className="text-ink-muted">{d}</dd>
                  </div>
                ))}
              </dl>
            </Panel>
          </Section>
        </div>

        <Section title="অবস্থার লেবেল বোঝা">
          <Panel>
            <dl className="divide-y divide-rule">
              {applicationStatusOrder.map((s) => (
                <div
                  key={s}
                  className="grid gap-2 px-5 py-3 sm:grid-cols-[12rem_minmax(0,1fr)] sm:items-start"
                >
                  <dt>
                    <StatusBadge {...applicationStatusMeta[s]} />
                  </dt>
                  <dd>{applicationStatusExplain[s]}</dd>
                </div>
              ))}
            </dl>
          </Panel>
        </Section>

        <Section title="এই প্রোটোটাইপের সীমা">
          <ul className="list-disc space-y-1.5 rounded-md bg-warning-soft p-5 pl-10">
            <li>সব নাম, নম্বর, নথি ও তারিখ কাল্পনিক। ডেমোর “আজ” ১৭ অক্টোবর ২০২৬।</li>
            <li>কোনো সরকারি সেবা, ওসিআর বা আসল লগইনের সঙ্গে যুক্ত নয়।</li>
            <li>জমির আইনি মালিকানা বা নথির সত্যতা নির্ধারণ করে না।</li>
            <li>
              আইনি বা প্রক্রিয়াগত প্রশ্নে সংশ্লিষ্ট ভূমি অফিস বা সরকারি নির্দেশনা দেখুন।
            </li>
          </ul>
        </Section>

        <p className="text-ink-muted">
          প্রথম পাতায় ফিরতে{" "}
          <a className="text-link" href={routeHref("landing")}>
            এখানে যান
          </a>
          ।
        </p>
      </div>
    </Page>
  )
}
