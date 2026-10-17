import type { Tone } from "@/lib/domain"
import Icon, { type IconName } from "./Icon"

export const toneClasses: Record<Tone, string> = {
  neutral: "bg-sunken text-ink",
  info: "bg-info-soft text-info",
  warning: "bg-warning-soft text-warning",
  success: "bg-success-soft text-success",
  danger: "bg-danger-soft text-danger",
}

interface StatusBadgeProps {
  tone: Tone
  icon: IconName
  label: string
}

/** Status is always carried by text and an icon shape, never by colour alone. */
export default function StatusBadge({ tone, icon, label }: StatusBadgeProps) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-sm px-2 py-0.5 text-sm font-medium whitespace-nowrap ${toneClasses[tone]}`}
    >
      <Icon name={icon} className="size-4" />
      {label}
    </span>
  )
}
