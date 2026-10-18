/** Wordmark with a simple parcel-outline mark. */
export default function Brand({
  suffix,
  inverse = false /** For deep-green surfaces. */,
}: {
  suffix?: string
  inverse?: boolean
}) {
  return (
    <a
      href="#/"
      className="flex items-center gap-2.5 rounded-sm py-1"
      aria-label="BhoomiTrace — প্রথম পাতা"
    >
      <svg
        viewBox="0 0 32 32"
        className="size-8 shrink-0"
        aria-hidden="true"
        focusable="false"
      >
        <rect
          width="32"
          height="32"
          rx="7"
          fill={inverse ? "var(--color-on-forest)" : "var(--color-accent)"}
        />
        <path
          d="M8 22 11.5 9 23 11 25 21 15 25Z"
          fill="none"
          stroke={inverse ? "var(--color-forest)" : "#fff"}
          strokeWidth="2"
          strokeLinejoin="round"
        />
      </svg>
      <span
        lang="en"
        className={`text-lg font-semibold ${
          inverse ? "text-on-forest" : "text-ink"
        }`}
      >
        BhoomiTrace
      </span>
      {suffix && (
        <span className="hidden border-l border-rule pl-2.5 text-sm text-ink-muted sm:inline">
          {suffix}
        </span>
      )}
    </a>
  )
}
