import { useId, type ReactNode } from "react"
import Brand from "@/components/shell/Brand"
import SiteFooter from "@/components/shell/SiteFooter"
import Icon from "@/components/ui/Icon"
import { routeHref } from "@/config/navigation"

interface Story {
  title: string
  body: string
}

const defaultStory: Story = {
  title: "আপনার ভূমি-রেকর্ডের কাজে ফিরে আসুন",
  body: "আপনার আবেদন, জমির তথ্য ও নথির অবস্থা এক জায়গায় দেখুন।",
}

/*
  A fragment of a mouza sheet: neighbouring dag parcels with one outlined, the way a
  surveyor marks the plot in question. Decorative only.
*/
const parcels = [
  { d: "M20 40 150 20 170 110 40 130Z", n: "১২৬", x: 95, y: 80 },
  {
    d: "M150 20 290 35 300 120 170 110Z",
    n: "৩৪১",
    x: 228,
    y: 76,
    focus: true,
  },
  { d: "M290 35 390 60 380 150 300 120Z", n: "৩৪২", x: 340, y: 97 },
  { d: "M40 130 170 110 185 220 30 235Z", n: "১২৭", x: 105, y: 178 },
  { d: "M170 110 300 120 310 230 185 220Z", n: "৩৪০", x: 242, y: 172 },
  { d: "M300 120 380 150 370 240 310 230Z", n: "৩৪৩", x: 340, y: 188 },
]

function ParcelSketch({ className = "" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 410 260"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <g fill="none" stroke="var(--color-on-forest)" strokeLinejoin="round">
        {parcels.map((p) => (
          <path
            key={p.n}
            d={p.d}
            strokeWidth={p.focus ? 1.75 : 1}
            strokeOpacity={p.focus ? 0.85 : 0.26}
            fill={p.focus ? "var(--color-on-forest)" : "none"}
            fillOpacity={p.focus ? 0.06 : 0}
          />
        ))}
        {/* Village path along the southern edge. */}
        <path
          d="M0 252C90 244 200 250 410 236"
          strokeWidth="1"
          strokeOpacity="0.3"
          strokeDasharray="5 6"
        />
      </g>
      <g
        fill="var(--color-on-forest)"
        fontFamily="var(--font-sans)"
        fontSize="15"
        textAnchor="middle"
      >
        {parcels.map((p) => (
          <text key={p.n} x={p.x} y={p.y} fillOpacity={p.focus ? 0.95 : 0.4}>
            {p.n}
          </text>
        ))}
      </g>
      {/* North arrow */}
      <g
        stroke="var(--color-on-forest)"
        strokeOpacity="0.45"
        fill="none"
        strokeWidth="1.25"
      >
        <path d="M395 6v22M389 14l6-8 6 8" />
      </g>
    </svg>
  )
}

const prototypeLabel = "স্বাধীন প্রোটোটাইপ · কাল্পনিক তথ্য"

/** Split frame for login, registration and recovery: brand context beside a calm form column. */
export default function AuthLayout({
  title,
  intro,
  story = defaultStory,
  children,
}: {
  title: string
  intro?: ReactNode
  story?: Story
  children: ReactNode
}) {

  return (
    <div className="flex min-h-dvh flex-col bg-folio">
      <a
        href="#main"
        onClick={(e) => {
          e.preventDefault()
          document.getElementById("main")?.focus()
        }}
        className="fixed top-2 left-2 z-50 -translate-y-[200%] rounded-sm bg-ink px-4 py-2 font-medium text-white focus:translate-y-0"
      >
        মূল অংশে যান
      </a>

      {/* Small screens: a compact brand strip, then straight to the form. */}
      <header className="forest-field relative overflow-hidden bg-forest lg:hidden">
        <ParcelSketch className="pointer-events-none absolute -top-10 -right-16 w-72 opacity-25" />
        <div className="relative flex min-h-16 flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-2 sm:px-6">
          <Brand inverse />
          <p className="text-xs text-on-forest-muted">স্বাধীন প্রোটোটাইপ</p>
        </div>
      </header>

      <div className="grid flex-1 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
        <aside
          aria-label="BhoomiTrace সম্পর্কে"
          className="forest-field hidden bg-forest text-on-forest lg:sticky lg:top-0 lg:flex lg:h-dvh lg:flex-col lg:justify-between lg:gap-8 lg:self-start lg:px-12 lg:py-10 xl:px-16 xl:py-12"
        >
          <div className="flex flex-wrap items-center justify-between gap-4">
            <Brand inverse />
            <p className="rounded-sm border border-forest-line px-2.5 py-0.5 text-xs text-on-forest-muted">
              {prototypeLabel}
            </p>
          </div>

          <div className="max-w-md">
            <p className="font-display text-2xl font-semibold text-balance xl:text-3xl">
              {story.title}
            </p>
            <p className="mt-5 text-lg text-on-forest-muted">{story.body}</p>
          </div>

          <figure className="max-w-xs">
            <ParcelSketch className="w-full" />
            <figcaption className="mt-3 border-t border-forest-line pt-3 text-xs text-on-forest-muted">
              নমুনা নকশা · মৌজা শালবন, দাগ ৩৪১
            </figcaption>
          </figure>
        </aside>

        <main
          id="main"
          tabIndex={-1}
          className="flex justify-center px-4 pt-6 pb-12 outline-none sm:px-6 sm:pt-10 lg:items-center lg:px-12 lg:py-16"
        >
          <div className="w-full max-w-md">
            <a href={routeHref("landing")} className="text-link text-sm">
              প্রথম পাতায় ফিরুন
            </a>
            <h1 className="mt-4 font-display text-2xl font-semibold text-ink">
              {title}
            </h1>
            {intro && <p className="mt-2 text-ink-muted">{intro}</p>}
            <div className="mt-8 space-y-6">{children}</div>
            <p className="mt-10 flex gap-2.5 border-t border-rule pt-5 text-xs text-ink-muted">
              <Icon name="info" className="mt-0.5 size-4 text-info" />
              <span>
                এটি একটি স্বাধীন প্রোটোটাইপ। এখানে কোনো আসল পরিচয় যাচাই হয় না, আর পাসওয়ার্ড
                কোথাও সংরক্ষণ বা পাঠানো হয় না। আসল জাতীয় পরিচয়পত্রের তথ্য দেবেন না।
              </span>
            </p>
          </div>
        </main>
      </div>
      <SiteFooter />
    </div>
  )
}

export function PasswordField({
  label,
  value,
  onChange,
  error,
  hint,
  shown,
  onToggle,
  autoComplete,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  error?: string
  hint?: string
  shown: boolean
  onToggle: () => void
  autoComplete: string
}) {
  const id = useId()
  const described =
    [hint && `${id}-hint`, error && `${id}-error`].filter(Boolean).join(" ") ||
    undefined
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium text-ink">
        {label}
      </label>
      {hint && (
        <p id={`${id}-hint`} className="mb-1.5 text-xs text-ink-muted">
          {hint}
        </p>
      )}
      {/* The toggle sits inside the field with a fixed width, so switching never shifts the input. */}
      <div className="relative">
        <input
          id={id}
          type={shown ? "text" : "password"}
          value={value}
          autoComplete={autoComplete}
          onChange={(e) => onChange(e.target.value)}
          aria-invalid={error ? true : undefined}
          aria-describedby={described}
          className={`block h-12 w-full min-w-0 rounded-sm border bg-surface pr-24 pl-3 text-base text-ink transition-colors duration-150 hover:border-ink ${
            error ? "border-2 border-danger" : "border-field"
          }`}
        />
        <button
          type="button"
          onClick={onToggle}
          aria-controls={id}
          className="absolute top-1/2 right-1 min-h-11 w-20 -translate-y-1/2 rounded-sm text-sm font-medium text-accent transition-colors duration-150 hover:bg-accent-soft"
        >
          {shown ? "লুকান" : "দেখান"}
          <span className="sr-only"> পাসওয়ার্ড</span>
        </button>
      </div>
      {error && (
        <p
          id={`${id}-error`}
          className="mt-1.5 text-sm font-medium text-danger"
        >
          {error}
        </p>
      )}
    </div>
  )
}

export const isEmail = (v: string) =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim())
