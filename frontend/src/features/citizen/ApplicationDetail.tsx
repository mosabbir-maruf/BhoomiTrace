import { fetchApplication } from "@/lib/api/dashboard"
import type { ApplicationDetail as Detail } from "@/lib/api/types"
import {
  applicationStatusExplain,
  applicationStatusMeta,
  applicationTypeLabel,
  documentStatusMeta,
} from "@/lib/domain"
import {
  formatDate,
  formatNumber,
  formatShare,
  toBengaliDigits,
} from "@/lib/format"
import { routeHref } from "@/config/navigation"
import { useRoute } from "@/hooks/useHashRoute"
import Load from "@/hooks/useLoader"
import Button, { LinkButton } from "@/components/ui/Button"
import { Page, Panel, Section } from "@/components/ui/Layout"
import { Notice } from "@/components/ui/States"
import StatusBadge from "@/components/ui/StatusBadge"
import { Deadline, Timeline, crumbs, trackingLabel } from "./shared"

/** The one action that fits each status. Pending applications never get approval-only actions. */
function primaryAction(app: Detail) {
  switch (app.status) {
    case "draft":
      return (
        <LinkButton href={routeHref("continue-application", app.id)} size="lg">
          খসড়া চালিয়ে যান
        </LinkButton>
      )
    case "documents_required":
      return (
        <Button
          size="lg"
          onClick={() => {
            // In-page jump without touching the hash, which drives routing.
            const target = document.getElementById("required-docs")
            target?.scrollIntoView({ block: "start" })
            target?.focus({ preventScroll: true })
          }}
        >
          কোন নথি লাগবে দেখুন
        </Button>
      )
    case "rejected":
      return (
        <LinkButton href={routeHref("new-application")} size="lg">
          নতুন আবেদন শুরু করুন
        </LinkButton>
      )
    case "approved":
      return app.parcel ? (
        <LinkButton href={routeHref("record", app.parcel.id)} size="lg">
          জমির রেকর্ড দেখুন
        </LinkButton>
      ) : null
    default:
      return null
  }
}

function Body({ app }: { app: Detail }) {
  const status = applicationStatusMeta[app.status]
  const requested = app.documents.filter((d) => d.status === "requested")
  const facts: [string, string][] = [
    ["ট্র্যাকিং নম্বর", trackingLabel(app)],
    ["জমার তারিখ", app.submittedAt ? formatDate(app.submittedAt) : "জমা হয়নি"],
    ["সর্বশেষ হালনাগাদ", formatDate(app.updatedAt)],
    ["জেলা ও উপজেলা", `${app.district}, ${app.upazila}`],
    ["মৌজা", app.mouza],
    [
      "খতিয়ান ও দাগ",
      `খতিয়ান ${toBengaliDigits(app.khatianNumber)}, দাগ ${toBengaliDigits(app.dagNumber)}`,
    ],
  ]
  const action = primaryAction(app)

  return (
    <div className="space-y-10">
      <Panel
        className={`p-5 sm:p-6 ${
          status.tone === "warning"
            ? "border-l-4 border-l-warning"
            : status.tone === "danger"
              ? "border-l-4 border-l-danger"
              : ""
        }`}
      >
        <div className="flex flex-col gap-5 md:flex-row md:items-start md:justify-between">
          <div className="min-w-0 space-y-2">
            <StatusBadge {...status} />
            <p className="max-w-[60ch] text-lg">
              {applicationStatusExplain[app.status]}
            </p>
            {app.nextStep && (
              <p>
                <span className="font-semibold">পরবর্তী ধাপ:</span> {app.nextStep}
              </p>
            )}
            {app.deadline && (
              <p>
                <span className="font-semibold">শেষ তারিখ:</span>{" "}
                <Deadline today={app.today} date={app.deadline} />
              </p>
            )}
            {app.decisionNote && (
              <Notice
                tone={app.status === "rejected" ? "warning" : "info"}
                title={app.status === "rejected" ? "কেন অনুমোদন পায়নি" : "নোট"}
              >
                {app.decisionNote} এটি কোনো আসল সরকারি সিদ্ধান্ত নয়।
              </Notice>
            )}
          </div>
          {action && <div className="shrink-0">{action}</div>}
        </div>
      </Panel>

      <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Section title="আবেদনের তথ্য">
          <Panel>
            <dl className="divide-y divide-rule">
              {facts.map(([k, v]) => (
                <div
                  key={k}
                  className="grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)] gap-4 px-5 py-3"
                >
                  <dt className="text-ink-muted">{k}</dt>
                  <dd
                    lang={
                      k === "ট্র্যাকিং নম্বর" && app.trackingNumber
                        ? "en"
                        : undefined
                    }
                    className="break-words"
                  >
                    {v}
                  </dd>
                </div>
              ))}
            </dl>
          </Panel>
          {app.parcel && (
            <p className="mt-3">
              সংশ্লিষ্ট রেকর্ড:{" "}
              <a
                href={routeHref("record", app.parcel.id)}
                className="text-link"
              >
                খতিয়ান {toBengaliDigits(app.parcel.khatianNumber)},{" "}
                {app.parcel.mouza} ({formatNumber(app.parcel.areaDecimal)} শতাংশ,
                অংশ {formatShare(app.parcel.ownershipShare)})
              </a>
            </p>
          )}
        </Section>

        <Section title="অবস্থার ইতিহাস" description="পুরোনো থেকে নতুন">
          <Panel className="p-5">
            <Timeline events={app.timeline} />
          </Panel>
        </Section>
      </div>

      <section
        id="required-docs"
        tabIndex={-1}
        aria-labelledby="docs-h"
        className="scroll-mt-24 outline-none"
      >
        <h2 id="docs-h" className="mb-1 text-xl font-semibold">
          নথির তালিকা
        </h2>
        <p className="mb-3 text-sm text-ink-muted">
          {requested.length > 0
            ? `${formatNumber(requested.length)}টি নথি এখনো জমা বাকি।`
            : "চাওয়া সব নথি জমা হয়েছে, অথবা কোনো নথি চাওয়া হয়নি।"}{" "}
          এই তালিকা নমুনা; আসল নিয়ম জানতে সংশ্লিষ্ট ভূমি অফিসের নির্দেশনা দেখুন।
        </p>
        {app.documents.length === 0 ? (
          <p className="rounded-md bg-surface px-5 py-4 text-ink-muted">
            এই আবেদনের সঙ্গে কোনো নথি যুক্ত নেই।
          </p>
        ) : (
          <ul className="divide-y divide-rule rounded-md border border-rule bg-surface">
            {app.documents.map((d) => (
              <li
                key={d.id}
                className="flex flex-col gap-2 px-5 py-4 sm:flex-row sm:items-start sm:justify-between"
              >
                <div className="min-w-0">
                  <a
                    href={routeHref("document", d.id)}
                    className="font-semibold text-accent underline decoration-accent/30 underline-offset-4 hover:decoration-accent"
                  >
                    {d.name}
                  </a>
                  <p className="text-ink-muted">{d.note}</p>
                </div>
                <StatusBadge {...documentStatusMeta[d.status]} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <p>
        <a href={routeHref("applications")} className="text-link">
          ← সব আবেদনে ফিরুন
        </a>
      </p>
    </div>
  )
}

export default function ApplicationDetailPage() {
  const { param = "" } = useRoute()
  return (
    <Load
      load={(signal) => fetchApplication(param, signal)}
      loadKey={param}
      framed
      notFound={{
        title: "আবেদনটি পাওয়া যায়নি",
        backHref: routeHref("applications"),
        backLabel: "সব আবেদন দেখুন",
      }}
    >
      {(app) => (
        <Page
          title={applicationTypeLabel[app.type]}
          breadcrumbs={crumbs("application", app.trackingNumber ?? "খসড়া")}
          description={`${app.mouza} মৌজা, দাগ ${toBengaliDigits(app.dagNumber)}। নমুনা আবেদন, কোনো আসল জমার রেকর্ড নয়।`}
        >
          <Body app={app} />
        </Page>
      )}
    </Load>
  )
}
