import Icon from "./Icon"

export interface Crumb {
  label: string
  href?: string
}

export default function Breadcrumbs({ items }: { items: Crumb[] }) {
  return (
    <nav aria-label="আপনার অবস্থান" className="mb-3">
      <ol className="flex flex-wrap items-center gap-1 text-sm text-ink-muted">
        {items.map((item, index) => {
          const isLast = index === items.length - 1
          return (
            <li key={item.label} className="flex items-center gap-1">
              {item.href && !isLast ? (
                <a
                  href={item.href}
                  className="rounded-sm underline decoration-rule-strong underline-offset-4 hover:text-ink hover:decoration-ink"
                >
                  {item.label}
                </a>
              ) : (
                <span
                  aria-current={isLast ? "page" : undefined}
                  className={isLast ? "text-ink" : undefined}
                >
                  {item.label}
                </span>
              )}
              {!isLast && <Icon name="chevronRight" className="size-4" />}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}
