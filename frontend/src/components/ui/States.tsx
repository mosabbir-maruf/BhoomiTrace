import type { ReactNode } from "react"
import type { Tone } from "@/lib/domain"
import Button from "./Button"
import Icon, { type IconName } from "./Icon"
import { toneClasses } from "./StatusBadge"

const noticeIcon: Record<Exclude<Tone, "neutral">, IconName> = {
  info: "info",
  warning: "alert",
  success: "check",
  danger: "xCircle",
}

interface NoticeProps {
  tone: Exclude<Tone, "neutral">
  title: string
  children?: ReactNode
  onDismiss?: () => void
}

/** Inline message. Errors are announced assertively, everything else politely. */
export function Notice({ tone, title, children, onDismiss }: NoticeProps) {
  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      className={`notice-in flex items-start gap-3 rounded-sm border-l-4 border-current px-4 py-3 ${toneClasses[tone]}`}
    >
      <Icon name={noticeIcon[tone]} className="mt-0.5 size-5" />
      <div className="min-w-0 flex-1 text-sm">
        <p className="font-semibold">{title}</p>
        {children && <div className="mt-0.5 text-ink">{children}</div>}
      </div>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          className="-m-1 inline-flex size-8 items-center justify-center rounded-sm text-ink hover:bg-white/60"
          aria-label="বার্তাটি বন্ধ করুন"
        >
          <Icon name="close" className="size-4" />
        </button>
      )}
    </div>
  )
}

interface EmptyStateProps {
  title: string
  children?: ReactNode
  action?: ReactNode
  icon?: IconName
}

export function EmptyState({
  title,
  children,
  action,
  icon = "file",
}: EmptyStateProps) {
  return (
    <div className="rounded-sm border border-dashed border-rule-strong bg-surface/60 px-6 py-10 text-center">
      <Icon name={icon} className="mx-auto size-8 text-ink-muted" />
      <h3 className="mt-3 font-semibold text-ink">{title}</h3>
      {children && (
        <div className="mx-auto mt-1 max-w-[46ch] text-sm text-ink-muted">
          {children}
        </div>
      )}
      {action && <div className="mt-5 flex justify-center">{action}</div>}
    </div>
  )
}

interface ErrorStateProps {
  title: string
  children?: ReactNode
  onRetry?: () => void
}

export function ErrorState({ title, children, onRetry }: ErrorStateProps) {
  return (
    <div
      role="alert"
      className="rounded-sm border border-danger/40 bg-danger-soft px-6 py-8"
    >
      <div className="flex items-start gap-3">
        <Icon name="alert" className="mt-1 size-6 text-danger" />
        <div>
          <h2 className="font-display text-lg font-semibold text-danger">
            {title}
          </h2>
          {children && (
            <div className="mt-1 max-w-[60ch] text-ink">{children}</div>
          )}
          {onRetry && (
            <Button
              variant="secondary"
              icon="refresh"
              onClick={onRetry}
              className="mt-4"
            >
              আবার চেষ্টা করুন
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

/** Placeholder blocks shaped like the content they stand in for. */
export function Skeleton({ className = "" }: { className?: string }) {
  return (
    <div
      className={`rounded-sm bg-sunken motion-safe:animate-pulse ${className}`}
      aria-hidden="true"
    />
  )
}

export function LoadingRegion({
  label,
  children,
}: {
  label: string
  children: ReactNode
}) {
  return (
    <div aria-busy="true">
      <p role="status" className="sr-only">
        {label}
      </p>
      {children}
    </div>
  )
}
