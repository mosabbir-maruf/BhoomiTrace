import type { ReactNode } from "react"
import { fetchApplicantDashboard } from "@/lib/api/dashboard"
import type {
  ApplicantDashboard,
  ApplicationSummary,
  TimelineEvent,
} from "@/lib/api/types"
import { applicationStatusMeta, applicationTypeLabel } from "@/lib/domain"
import {
  daysBetween,
  formatDate,
  formatDaysLeft,
  toBengaliDigits,
} from "@/lib/format"
import {
  routeAncestors,
  routeHref,
  routeTitle,
  type RouteId,
} from "@/config/navigation"
import Load from "@/hooks/useLoader"
import StatusBadge from "@/components/ui/StatusBadge"

/** Breadcrumb trail: ancestors as links, then the current page (optionally renamed). */
export function crumbs(route: RouteId, current?: string) {
  return [
    ...routeAncestors(route).map((id) => ({
      label: routeTitle(id),
      href: routeHref(id),
    })),
    { label: current ?? routeTitle(route) },
  ]
}

/** Loads the applicant's data and handles loading and error states the same way on every page. */
export function WithApplicantData({
  children,
}: {
  children: (data: ApplicantDashboard) => ReactNode
}) {
  return (
    <Load load={fetchApplicantDashboard} loadKey="dashboard">
      {children}
    </Load>
  )
}

export function trackingLabel(a: ApplicationSummary) {
  return a.trackingNumber ?? "খসড়া, এখনো জমা হয়নি"
}

/** Deadline with an explicit overdue state; past dates are never shown as upcoming. */
export function Deadline({ today, date }: { today: string; date: string }) {
  const overdue = daysBetween(today, date) < 0
  return (
    <span className="block">
      <span className="font-semibold">{formatDate(date)}</span>{" "}
      {overdue ? (
        <StatusBadge
          tone="danger"
          icon="alert"
          label={formatDaysLeft(today, date)}
        />
      ) : (
        <span className="text-sm font-medium text-warning">
          {formatDaysLeft(today, date)}
        </span>
      )}
    </span>
  )
}

function Cell({
  label,
  children,
  className = "",
}: {
  label: string
  children: ReactNode
  className?: string
}) {
  return (
    <div className={`min-w-0 ${className}`}>
      <dt className="text-sm text-ink-muted md:sr-only">{label}</dt>
      <dd>{children}</dd>
    </div>
  )
}

/** Readable rows on desktop, stacked summaries on mobile. Each row opens the application. */
export function ApplicationList({
  applications,
  today,
}: {
  applications: ApplicationSummary[]
  today?: string
}) {
  const grid =
    "md:grid md:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.5fr)] md:gap-6"
  return (
    <div className="overflow-hidden rounded-md border border-rule bg-surface">
      <div
        aria-hidden="true"
        className={`hidden bg-sunken px-5 py-2.5 text-sm font-medium text-ink-muted ${grid}`}
      >
        <span>আবেদন</span>
        <span>অবস্থা</span>
        <span>জমি</span>
        <span>পরবর্তী ধাপ</span>
      </div>
      <ul className="divide-y divide-rule">
        {applications.map((a) => (
          <li
            key={a.id}
            className="relative px-5 py-4 transition-colors duration-150 hover:bg-paper"
          >
            <dl
              className={`grid grid-cols-2 gap-x-4 gap-y-3 ${grid} md:items-start`}
            >
              <Cell label="আবেদন" className="[&>dt]:sr-only">
                {/* The link covers the whole row (::after), so the full summary is clickable. */}
                <a
                  href={routeHref("application", a.id)}
                  className="block font-semibold text-accent underline decoration-accent/30 underline-offset-4 after:absolute after:inset-0 hover:decoration-accent"
                >
                  {applicationTypeLabel[a.type]}
                </a>
                <span
                  lang={a.trackingNumber ? "en" : undefined}
                  className="block text-sm text-ink-muted tabular"
                >
                  {trackingLabel(a)}
                </span>
              </Cell>
              <Cell label="অবস্থা" className="[&>dt]:sr-only">
                <StatusBadge {...applicationStatusMeta[a.status]} />
                <span className="mt-1 block text-sm text-ink-muted">
                  হালনাগাদ {formatDate(a.updatedAt)}
                </span>
              </Cell>
              <Cell label="জমি" className="col-span-2 md:col-span-1">
                {a.mouza} মৌজা
                <span className="block text-sm text-ink-muted">
                  খতিয়ান {toBengaliDigits(a.khatianNumber)}, দাগ{" "}
                  {toBengaliDigits(a.dagNumber)}
                </span>
              </Cell>
              <Cell label="পরবর্তী ধাপ" className="col-span-2 md:col-span-1">
                {a.nextStep ?? (
                  <span className="text-ink-muted">এখন আপনার কিছু করার নেই</span>
                )}
                {a.deadline && today && (
                  <span className="mt-1 block text-sm">
                    শেষ তারিখ: <Deadline today={today} date={a.deadline} />
                  </span>
                )}
              </Cell>
            </dl>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** Vertical timeline of past events, oldest first. */
export function Timeline({ events }: { events: TimelineEvent[] }) {
  return (
    <ol className="relative space-y-5 border-l-2 border-rule pl-6">
      {events.map((e, i) => (
        <li key={`${e.date}-${i}`} className="relative">
          <span
            aria-hidden="true"
            className={`absolute top-1.5 -left-[1.95rem] size-3.5 rounded-full border-2 ${
              i === events.length - 1
                ? "border-accent bg-accent"
                : "border-rule-strong bg-surface"
            }`}
          />
          <p className="text-sm text-ink-muted">{formatDate(e.date)}</p>
          <p className="font-semibold">{e.title}</p>
          {e.note && <p className="text-ink-muted">{e.note}</p>}
        </li>
      ))}
    </ol>
  )
}
