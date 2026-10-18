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
          rx="7.5"
          fill={inverse ? "var(--color-on-forest)" : "var(--color-accent)"}
        />
        <path
          d="M6 24 L11 7 L26 9.5 L23 25.5 Z"
          fill="none"
          stroke={inverse ? "var(--color-forest)" : "#fff"}
          strokeWidth="1"
          strokeOpacity="0.25"
          strokeLinejoin="round"
        />
        <circle
          cx="26"
          cy="9.5"
          r="1.8"
          fill="#f59e0b"
        />
        <path
          d="M7 9 H13 C15.5 9 17.2 10.3 17.2 12.5 C17.2 14.1 16.2 15.1 14.6 15.6 C16.6 16 17.8 17.5 17.8 19.6 C17.8 22.2 15.6 23.5 13 23.5 H7 Z M10.2 11.8 V14.6 H12.8 C13.9 14.6 14.5 14 14.5 13.2 C14.5 12.3 13.9 11.8 12.8 11.8 Z M10.2 17.3 V20.7 H13 C14.3 20.7 15.1 20.1 15.1 18.9 C15.1 17.8 14.3 17.3 13 17.3 Z"
          fill={inverse ? "var(--color-forest)" : "#ffffff"}
        />
        <path
          d="M18.2 11.5 H25.2 V14.3 H23 V23.5 H20.4 V14.3 H18.2 Z"
          fill={inverse ? "var(--color-accent)" : "#6ee7b7"}
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
