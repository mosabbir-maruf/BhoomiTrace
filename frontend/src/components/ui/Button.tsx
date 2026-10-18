import type {
  AnchorHTMLAttributes,
  ButtonHTMLAttributes,
  ReactNode,
} from "react"
import Icon, { type IconName } from "./Icon"

type Variant = "primary" | "secondary" | "ghost"
type Size = "lg" | "md" | "sm"

const base =
  "inline-flex items-center justify-center gap-2 rounded-sm font-medium whitespace-nowrap select-none " +
  "transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-55"

const variants: Record<Variant, string> = {
  primary: "bg-accent text-white hover:bg-accent-hover",
  secondary: "border border-rule-strong bg-surface text-ink hover:bg-sunken",
  ghost: "text-accent hover:bg-accent-soft",
}

const sizes: Record<Size, string> = {
  lg: "min-h-12 px-6 text-base",
  md: "min-h-11 px-4 text-base",
  sm: "min-h-11 px-3 text-sm",
}

export function buttonClasses(
  variant: Variant = "primary",
  size: Size = "md",
  extra = "",
): string {
  return `${base} ${variants[variant]} ${sizes[size]} ${extra}`
}

interface CommonProps {
  variant?: Variant
  size?: Size
  icon?: IconName
  children: ReactNode
}

type ButtonProps = CommonProps & ButtonHTMLAttributes<HTMLButtonElement> & {
  loading?: boolean
  /** Replaces the label while loading, for example "পাঠানো হচ্ছে". */
  loadingLabel?: string
}

export default function Button({
  variant,
  size,
  icon,
  loading = false,
  loadingLabel,
  children,
  className = "",
  disabled,
  type = "button",
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={buttonClasses(variant, size, className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? (
        <span
          className="size-4 rounded-full border-2 border-current border-r-transparent motion-safe:animate-spin"
          aria-hidden="true"
        />
      ) : (
        icon && <Icon name={icon} className="size-[1.125rem]" />
      )}
      <span>{loading && loadingLabel ? loadingLabel : children}</span>
    </button>
  )
}

type LinkButtonProps = CommonProps & AnchorHTMLAttributes<HTMLAnchorElement> & {
  href: string
}

export function LinkButton({
  variant,
  size,
  icon,
  children,
  className = "",
  ...rest
}: LinkButtonProps) {
  return (
    <a className={buttonClasses(variant, size, className)} {...rest}>
      {icon && <Icon name={icon} className="size-[1.125rem]" />}
      <span>{children}</span>
    </a>
  )
}
