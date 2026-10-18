import { useEffect, useRef, useState, type ReactNode } from "react"
import {
  citizenNav,
  reviewerNav,
  routeSeoTitle,
  routeTitle,
  type RouteId,
} from "@/config/navigation"
import { isLiveData } from "@/lib/api/session"
import Icon from "@/components/ui/Icon"
import Brand from "./Brand"
import MobileNav from "./MobileNav"
import NavLinks from "./NavLinks"
import SampleDataBanner from "./SampleDataBanner"
import UserMenu from "./UserMenu"
import SiteFooter from "./SiteFooter"

interface AppShellProps {
  route: RouteId
  /** Changes when the record shown changes, so focus and scroll reset on detail-to-detail navigation. */
  pageKey: string
  audience: "citizen" | "reviewer" | "admin"
  children: ReactNode
}

export default function AppShell({
  route,
  pageKey,
  audience,
  children,
}: AppShellProps) {
  const [navOpen, setNavOpen] = useState(false)
  const mainRef = useRef<HTMLElement>(null)
  const isFirstRender = useRef(true)
  const items = audience === "citizen" ? citizenNav : reviewerNav
  const label =
    audience === "citizen"
      ? "নাগরিক ডেমো"
      : audience === "admin"
        ? "প্রশাসক ড্যাশবোর্ড"
        : "পর্যালোচক ডেমো"
  const tone = audience === "citizen" ? "citizen" : "reviewer"
  // Reviewer labels are longer, so the full bar needs a wider screen.
  const wide = audience === "citizen" ? "lg" : "xl"

  // On client-side navigation, update the title and move focus to the new page.
  useEffect(() => {
    document.title = routeSeoTitle(route)
    if (isFirstRender.current) {
      isFirstRender.current = false
      return
    }
    mainRef.current?.focus({ preventScroll: true })
    window.scrollTo({ top: 0 })
  }, [route, pageKey])

  return (
    <div className="flex min-h-dvh flex-col">
      <a
        href="#main"
        onClick={(event) => {
          // Hash links drive routing, so move focus directly instead of changing the URL.
          event.preventDefault()
          mainRef.current?.focus()
        }}
        className="fixed top-2 left-2 z-50 -translate-y-[200%] rounded-sm bg-ink px-4 py-2 font-medium text-white focus:translate-y-0"
      >
        মূল বিষয়বস্তুতে যান
      </a>

      {!isLiveData && <SampleDataBanner />}
      <header className="sticky top-0 z-20 border-b border-rule bg-surface">
        <div className="page-width flex min-h-16 items-center justify-between gap-4">
          <Brand suffix={label} />
          <nav
            aria-label="প্রধান মেনু"
            className={wide === "lg" ? "hidden lg:block" : "hidden xl:block"}
          >
            <NavLinks items={items} route={route} layout="bar" tone={tone} />
          </nav>
          <div className="flex items-center gap-2">
            <UserMenu />
            <button
              type="button"
              onClick={() => setNavOpen(true)}
              aria-expanded={navOpen}
              className={`inline-flex min-h-11 items-center gap-2 rounded-sm border border-rule-strong px-3 ${
                wide === "lg" ? "lg:hidden" : "xl:hidden"
              }`}
            >
              <Icon name="menu" />
              মেনু
            </button>
          </div>
        </div>
        {audience === "reviewer" && (
          <div className="bg-info text-white">
            <p className="page-width py-1.5 text-sm">
              পর্যালোচকের কর্মক্ষেত্র (ডেমো)। এখানে নেওয়া সিদ্ধান্ত শুধু এই ব্রাউজার ট্যাবে থাকে,
              কোথাও সংরক্ষণ হয় না।
            </p>
          </div>
        )}
      </header>

      <main
        id="main"
        ref={mainRef}
        tabIndex={-1}
        className="flex-1 outline-none"
      >
        {children}
      </main>

      <SiteFooter />

      <MobileNav
        open={navOpen}
        onClose={() => setNavOpen(false)}
        route={route}
        items={items}
        title={label}
        tone={tone}
      />
    </div>
  )
}
