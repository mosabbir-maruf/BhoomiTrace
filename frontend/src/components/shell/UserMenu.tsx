import { useEffect, useId, useRef, useState } from "react"
import { signOut, useSession } from "@/lib/api/session"
import { navigate, routeHref } from "@/hooks/useHashRoute"
import Icon from "@/components/ui/Icon"

const roleLabel: Record<"citizen" | "reviewer" | "admin", string> = {
  citizen: "আবেদনকারী",
  reviewer: "পর্যালোচক",
  admin: "প্রশাসক",
}

/** Disclosure-pattern account menu: a button that reveals a panel of links. */
export default function UserMenu() {
  const session = useSession()
  const [open, setOpen] = useState(false)
  const wrapperRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const panelId = useId()

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (!wrapperRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false)
        buttonRef.current?.focus()
      }
    }
    document.addEventListener("pointerdown", onPointerDown)
    document.addEventListener("keydown", onKeyDown)
    return () => {
      document.removeEventListener("pointerdown", onPointerDown)
      document.removeEventListener("keydown", onKeyDown)
    }
  }, [open])

  if (!session) return null
  const close = () => setOpen(false)
  const itemClass =
    "flex min-h-12 w-full items-center gap-3 px-5 text-left text-base text-ink transition-colors duration-150 hover:bg-sunken"

  return (
    <div
      ref={wrapperRef}
      className="sm:relative"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          setOpen(false)
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
        className={`flex min-h-11 items-center gap-2.5 rounded-sm border-2 py-1 pr-3 pl-1.5 transition-colors duration-150 hover:bg-sunken ${
          open ? "border-ink" : "border-transparent"
        }`}
      >
        <span
          className={`inline-flex size-8 items-center justify-center rounded-full font-semibold text-white ${
            session.role === "reviewer" ? "bg-info" : "bg-ink"
          }`}
          aria-hidden="true"
        >
          {session.displayName.slice(0, 1)}
        </span>
        <span className="hidden max-w-[12rem] truncate font-semibold sm:inline">
          {session.displayName}
        </span>
        <span className="sr-only sm:hidden">
          অ্যাকাউন্ট মেনু: {session.displayName}
        </span>
        <Icon
          name="chevronDown"
          className={`size-4 transition-transform duration-150 ${
            open ? "rotate-180" : ""
          }`}
        />
      </button>

      <div
        id={panelId}
        hidden={!open}
        className="absolute top-full right-4 left-4 z-30 mt-1 rounded-sm border border-rule bg-surface shadow-float sm:top-auto sm:right-0 sm:left-auto sm:mt-2 sm:w-[22rem]"
      >
        <div className="border-b border-rule px-5 pt-4 pb-3.5">
          <p className="text-lg font-semibold text-ink">
            {session.displayName}
          </p>
          <p className="mt-0.5 text-[0.9375rem] text-ink-muted">
            {roleLabel[session.role]}, অ্যাকাউন্ট{" "}
            <span lang="en" className="tabular">
              {session.accountId}
            </span>
          </p>
        </div>
        <ul className="py-2">
          <li>
            <a
              href={routeHref("profile")}
              onClick={close}
              className={itemClass}
            >
              <Icon name="user" className="size-5 text-ink-muted" />
              আমার প্রোফাইল
            </a>
          </li>
          <li>
            <a
              href={routeHref("profile", undefined, { section: "settings" })}
              onClick={close}
              className={itemClass}
            >
              <Icon name="refresh" className="size-5 text-ink-muted" />
              ডেমো সেটিংস ও ভূমিকা বদল
            </a>
          </li>
          <li>
            <a href={routeHref("help")} onClick={close} className={itemClass}>
              <Icon name="help" className="size-5 text-ink-muted" />
              সহায়তা
            </a>
          </li>
        </ul>
        <div className="border-t border-rule py-2">
          <button
            type="button"
            className={itemClass}
            onClick={() => {
              close()
              signOut()
              navigate(routeHref("login", undefined, { signedOut: "1" }))
            }}
          >
            <Icon name="logout" className="size-5 text-ink-muted" />
            লগআউট
          </button>
        </div>
      </div>
    </div>
  )
}
