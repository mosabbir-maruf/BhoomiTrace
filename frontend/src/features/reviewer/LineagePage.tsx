import { routeHref } from "@/config/navigation"
import { useRoute } from "@/hooks/useHashRoute"
import {
  lineageLinks,
  lineageNodes,
  reviewCases,
  surveyNames,
  syntheticRecords,
  versionIds,
} from "@/mocks/evidence"
import { Page, Panel, Section } from "@/components/ui/Layout"
import { Notice } from "@/components/ui/States"
import StatusBadge from "@/components/ui/StatusBadge"
import { isCurrentSessionLive } from "@/lib/api/session"

const kindLabel = {
  continued: "একই জমি চলমান",
  renumbered: "নম্বর বদলেছে",
  split: "ভাগ হয়েছে",
} as const

export default function LineagePage() {
  const { query } = useRoute()
  const fromCase = reviewCases.find((c) => c.id === query.get("case"))
  const focus = fromCase
    ? `${fromCase.record}-${syntheticRecords[fromCase.record].values.khatian}`
    : null
  const focusId = focus
    ? lineageNodes.find((n) => `${n.version}-${n.khatian}` === focus)?.id
    : undefined
  const label = (id: string) => {
    const n = lineageNodes.find((x) => x.id === id)
    return n ? `${surveyNames[n.version]} খতিয়ান ${n.khatian}` : id
  }
  const crumbs = fromCase
    ? [
        { label: "পর্যালোচনার তালিকা", href: routeHref("queue") },
        { label: fromCase.reference, href: routeHref("case", fromCase.id) },
        { label: "রেকর্ডের ধারা" },
      ]
    : [
        { label: "পর্যালোচনার তালিকা", href: routeHref("queue") },
        { label: "রেকর্ডের ইতিহাস" },
      ]

  return (
    <Page
      title="রেকর্ডের ইতিহাস"
      breadcrumbs={crumbs}
      description="সিএস থেকে বিএস পর্যন্ত একই জমির রেকর্ড কীভাবে বদলেছে (কাল্পনিক নমুনা)। “অনুমিত” সংযোগ কেউ মিলিয়ে দেখেনি।"
    >
      <div className="space-y-10">
        <Notice tone="info" title="ডেমো মোড — কাল্পনিক রেকর্ড ইতিহাস">
          সিএস থেকে বিএস পর্যন্ত ধারাবাহিক খতিয়ানের এই ভিজ্যুয়াল গ্রাফটি প্রোটোটাইপ প্রদর্শনীমূলক এবং কাল্পনিক নমুনা ডেটা ব্যবহার করছে।
          {isCurrentSessionLive() && " সরাসরি ব্যাকএন্ডের জমির রেকর্ড দেখতে জমির রেকর্ড তালিকা বা সংশ্লিষ্ট রেকর্ডের বিস্তারিত পাতা ব্যবহার করুন।"}
        </Notice>
        <Section title="জরিপ অনুযায়ী রেকর্ড">
          <ol className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {versionIds.map((v) => (
              <li key={v} className="rounded-md bg-surface p-4">
                <h3 className="font-semibold">{surveyNames[v]}</h3>
                <ul className="mt-3 space-y-2">
                  {lineageNodes
                    .filter((n) => n.version === v)
                    .map((n) => (
                      <li
                        key={n.id}
                        aria-current={n.id === focusId ? "true" : undefined}
                        className={`rounded-sm border p-3 ${
                          n.id === focusId
                            ? "border-accent bg-accent-soft"
                            : "border-rule"
                        }`}
                      >
                        <p className="font-medium">
                          খতিয়ান {n.khatian}
                          {n.id === focusId && (
                            <span className="ml-2 text-sm text-accent">
                              (এই মামলা)
                            </span>
                          )}
                        </p>
                        <p className="text-sm text-ink-muted">
                          দাগ {n.dag} · {n.area} · {n.year}
                        </p>
                      </li>
                    ))}
                </ul>
              </li>
            ))}
          </ol>
        </Section>

        <Section
          title="রেকর্ডগুলোর সংযোগ"
          description="প্রতিটি সংযোগের উৎস ও নিশ্চয়তা।"
        >
          <Panel>
            <ul className="divide-y divide-rule">
              {lineageLinks.map((l) => (
                <li
                  key={`${l.from}-${l.to}`}
                  className="grid gap-2 px-5 py-4 md:grid-cols-[minmax(0,1fr)_10rem] md:items-start"
                >
                  <div>
                    <p className="font-medium">
                      {label(l.from)} → {label(l.to)}
                    </p>
                    <p className="text-sm text-ink-muted">
                      {kindLabel[l.kind]} · উৎস: {l.reference}
                    </p>
                    <p className="mt-1">{l.note}</p>
                  </div>
                  <StatusBadge
                    {...(l.certainty === "sample"
                      ? {
                          label: "নমুনায় আছে",
                          tone: "success" as const,
                          icon: "check" as const,
                        }
                      : {
                          label: "অনুমিত, যাচাই হয়নি",
                          tone: "warning" as const,
                          icon: "alert" as const,
                        })}
                  />
                </li>
              ))}
            </ul>
          </Panel>
        </Section>

        <p className="flex flex-wrap gap-x-6 gap-y-2">
          {fromCase && (
            <a className="text-link" href={routeHref("case", fromCase.id)}>
              নথি যাচাইয়ে ফিরুন
            </a>
          )}
          <a
            className="text-link"
            href={routeHref(
              "compare",
              undefined,
              fromCase ? { case: fromCase.id } : undefined,
            )}
          >
            দুটি রেকর্ড পাশাপাশি দেখুন
          </a>
        </p>
      </div>
    </Page>
  )
}
