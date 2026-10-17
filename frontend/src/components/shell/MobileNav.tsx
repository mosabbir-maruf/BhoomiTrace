import { useEffect, useRef } from "react"
import type { NavigationItem, RouteId } from "@/config/navigation"
import { routeHref } from "@/hooks/useHashRoute"
import Icon from "@/components/ui/Icon"
import NavLinks from "./NavLinks"

interface MobileNavProps {
  open: boolean
  onClose: () => void
  route: RouteId
  items: NavigationItem[]
  title: string
  tone: "citizen" | "reviewer"
}

/** Native modal dialog: focus is trapped, Escape closes, and focus returns to the trigger. */
export default function MobileNav({
  open,
  onClose,
  route,
  items,
  title,
  tone,
}: MobileNavProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (open && !dialog.open) dialog.showModal()
    if (!open && dialog.open) dialog.close()
  }, [open])

  return (
    <dialog
      ref={dialogRef}
      aria-label="মেনু"
      className="nav-drawer bg-surface text-ink"
      onClose={onClose}
      onClick={(event) => {
        if (event.target === dialogRef.current) onClose()
      }}
    >
      <div className="flex h-full flex-col gap-4 p-4">
        <div className="flex items-center justify-between">
          <p className="font-semibold">{title}</p>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex size-11 items-center justify-center rounded-sm hover:bg-sunken"
            aria-label="মেনু বন্ধ করুন"
          >
            <Icon name="close" />
          </button>
        </div>
        <nav aria-label="প্রধান মেনু">
          <NavLinks
            items={items}
            route={route}
            layout="list"
            tone={tone}
            onNavigate={onClose}
          />
        </nav>
        <a
          href={routeHref("landing")}
          onClick={onClose}
          className="text-link mt-auto px-3"
        >
          প্রথম পাতায় ফিরুন
        </a>
      </div>
    </dialog>
  )
}
