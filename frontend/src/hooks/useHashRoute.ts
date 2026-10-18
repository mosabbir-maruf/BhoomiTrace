import { useSyncExternalStore } from "react"
import { parseHash, type Route } from "@/config/navigation"

/*
  Minimal hash routing: enough for a static preview without adding a router dependency.
  Every route change is a real history entry, so browser back/forward and refresh work.
*/
let cachedHash: string | null = null
let cachedRoute: Route = parseHash("")

function read(): Route {
  if (window.location.hash !== cachedHash) {
    cachedHash = window.location.hash
    cachedRoute = parseHash(cachedHash)
  }
  return cachedRoute
}

function subscribe(callback: () => void) {
  window.addEventListener("hashchange", callback)
  return () => window.removeEventListener("hashchange", callback)
}

export function useRoute(): Route {
  return useSyncExternalStore(subscribe, read, () => cachedRoute)
}

export function navigate(href: string, { replace = false } = {}) {
  if (replace) window.location.replace(href)
  else window.location.hash = href.replace(/^#/, "")
}

export { routeHref } from "@/config/navigation"
