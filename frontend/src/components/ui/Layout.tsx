import { useId, type ReactNode } from "react"
import Breadcrumbs, { type Crumb } from "./Breadcrumbs"

interface PageProps {
  title: string
  description?: ReactNode
  breadcrumbs?: Crumb[]
  actions?: ReactNode
  children: ReactNode
}

/** Page frame: optional breadcrumb trail, the single h1, and primary actions. */
export function Page({
  title,
  description,
  breadcrumbs,
  actions,
  children,
}: PageProps) {
  return (
    <div className="page-width pb-16">
      <header className="pt-6 pb-6 md:pt-8">
        {breadcrumbs && <Breadcrumbs items={breadcrumbs} />}
        <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
          <div className="min-w-0">
            <h1 className="font-display text-2xl font-semibold text-ink md:text-[2.25rem] md:leading-tight">
              {title}
            </h1>
            {description && (
              <p className="mt-2 max-w-[62ch] text-ink-muted">{description}</p>
            )}
          </div>
          {actions && (
            <div className="flex shrink-0 flex-wrap gap-3">{actions}</div>
          )}
        </div>
      </header>
      {children}
    </div>
  )
}

interface SectionProps {
  title: string
  description?: ReactNode
  actions?: ReactNode
  className?: string
  children: ReactNode
}

export function Section({
  title,
  description,
  actions,
  className = "",
  children,
}: SectionProps) {
  const headingId = useId()
  return (
    <section aria-labelledby={headingId} className={className}>
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h2 id={headingId} className="text-xl font-semibold text-ink">
            {title}
          </h2>
          {description && (
            <p className="text-sm text-ink-muted">{description}</p>
          )}
        </div>
        {actions}
      </div>
      {children}
    </section>
  )
}

/** The one card style used across the app. */
export function Panel({
  className = "",
  children,
}: {
  className?: string
  children: ReactNode
}) {
  return (
    <div className={`rounded-md border border-rule bg-surface ${className}`}>
      {children}
    </div>
  )
}

/** Short plain-language explanation for an unfamiliar land-record term. */
export function Term({ word, children }: { word: string; children: ReactNode }) {
  return (
    <p className="text-sm text-ink-muted">
      <strong className="font-semibold text-ink">{word}:</strong> {children}
    </p>
  )
}
