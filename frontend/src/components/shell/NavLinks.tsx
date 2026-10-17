import type { NavigationItem, RouteId } from "@/config/navigation"
import { routeHref } from "@/hooks/useHashRoute"
import Icon from "@/components/ui/Icon"

interface NavLinksProps {
  items: NavigationItem[]
  route: RouteId
  layout: "bar" | "list"
  tone?: "citizen" | "reviewer"
  onNavigate?: () => void
}

export default function NavLinks({
  items,
  route,
  layout,
  tone = "citizen",
  onNavigate,
}: NavLinksProps) {
  const activeClass =
    tone === "citizen"
      ? "bg-accent-soft font-semibold text-accent"
      : "bg-info-soft font-semibold text-info"
  return (
    <ul
      className={
        layout === "bar" ? "flex items-center gap-1" : "flex flex-col gap-1"
      }
    >
      {items.map((item) => {
        const current = route === item.id
        const active = current || item.section.includes(route)
        return (
          <li key={item.id}>
            <a
              href={routeHref(item.id)}
              onClick={onNavigate}
              aria-current={current ? "page" : active ? "true" : undefined}
              className={`flex min-h-11 items-center gap-2.5 rounded-sm px-3 text-base whitespace-nowrap transition-colors duration-150 ${
                active ? activeClass : "text-ink hover:bg-sunken"
              }`}
            >
              {layout === "list" && <Icon name={item.icon} />}
              {item.label}
            </a>
          </li>
        )
      })}
    </ul>
  )
}
