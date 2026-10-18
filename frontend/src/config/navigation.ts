import type { IconName } from "@/components/ui/Icon"

/*
  Route table for the lightweight hash router. Each route has a URL pattern,
  an audience (who may open it in the demo) and a breadcrumb parent.
  Audiences are a demo convenience only, not a security boundary.
*/

export type Audience = "public" | "citizen" | "reviewer" | "signed-in"

interface RouteDef {
  /** Path segments; ":id" captures a record ID. */
  path: string
  title: string
  audience: Audience
  /** Breadcrumb parent route ID. */
  parent?: string
}

export const routes = {
  landing: { path: "", title: "BhoomiTrace", audience: "public" },
  login: { path: "login", title: "লগইন", audience: "public" },
  register: { path: "register", title: "নতুন অ্যাকাউন্ট", audience: "public" },
  "forgot-password": {
    path: "forgot-password",
    title: "পাসওয়ার্ড পুনরুদ্ধার",
    audience: "public",
  },
  enter: { path: "demo/:id", title: "ডেমোতে প্রবেশ", audience: "public" },

  dashboard: { path: "dashboard", title: "আমার ড্যাশবোর্ড", audience: "citizen" },
  applications: {
    path: "applications",
    title: "আমার আবেদন",
    audience: "citizen",
    parent: "dashboard",
  },
  application: {
    path: "applications/:id",
    title: "আবেদনের বিস্তারিত",
    audience: "citizen",
    parent: "applications",
  },
  "new-application": {
    path: "new-application",
    title: "নতুন আবেদন",
    audience: "citizen",
    parent: "applications",
  },
  "continue-application": {
    path: "new-application/:id",
    title: "খসড়া আবেদন",
    audience: "citizen",
    parent: "applications",
  },
  records: {
    path: "records",
    title: "জমির রেকর্ড",
    audience: "citizen",
    parent: "dashboard",
  },
  record: {
    path: "records/:id",
    title: "রেকর্ডের বিস্তারিত",
    audience: "citizen",
    parent: "records",
  },
  documents: {
    path: "documents",
    title: "নথিপত্র",
    audience: "citizen",
    parent: "dashboard",
  },
  document: {
    path: "documents/:id",
    title: "নথির বিস্তারিত",
    audience: "citizen",
    parent: "documents",
  },

  help: { path: "help", title: "সহায়তা", audience: "signed-in" },
  profile: { path: "profile", title: "আমার প্রোফাইল", audience: "signed-in" },

  queue: { path: "reviewer", title: "পর্যালোচনার তালিকা", audience: "reviewer" },
  desk: {
    path: "reviewer/cases",
    title: "নথি যাচাই",
    audience: "reviewer",
    parent: "queue",
  },
  case: {
    path: "reviewer/cases/:id",
    title: "নথি যাচাই",
    audience: "reviewer",
    parent: "queue",
  },
  compare: {
    path: "reviewer/compare",
    title: "রেকর্ড মিলিয়ে দেখা",
    audience: "reviewer",
    parent: "queue",
  },
  lineage: {
    path: "reviewer/lineage",
    title: "রেকর্ডের ইতিহাস",
    audience: "reviewer",
    parent: "queue",
  },

  "not-found": { path: "404", title: "পাতা পাওয়া যায়নি", audience: "public" },
} as const satisfies Record<string, RouteDef>

export type RouteId = keyof typeof routes

export interface Route {
  id: RouteId
  /** Captured ":id" segment, when the pattern has one. */
  param?: string
  query: URLSearchParams
}

/** Older links keep working after routes were renamed. */
const aliases: Record<string, string> = {
  evidence: "reviewer",
  review: "reviewer",
}

export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#\/?/, "")
  const [pathPart, queryPart = ""] = raw.split("?")
  const query = new URLSearchParams(queryPart)
  const path = aliases[pathPart] ?? pathPart
  const segments = path.split("/").filter(Boolean)
  for (const [id, def] of Object.entries(routes) as [RouteId, RouteDef][]) {
    const pattern = def.path.split("/").filter(Boolean)
    if (pattern.length !== segments.length) continue
    let param: string | undefined
    const ok = pattern.every((part, i) => {
      if (part === ":id") {
        param = decodeURIComponent(segments[i])
        return true
      }
      return part === segments[i]
    })
    if (ok) return { id, param, query }
  }
  return { id: segments.length ? "not-found" : "landing", query }
}

export function routeHref(
  id: RouteId,
  param?: string,
  query?: Record<string, string>,
): string {
  const path = routes[id].path.replace(":id", encodeURIComponent(param ?? ""))
  const qs = query ? `?${new URLSearchParams(query)}` : ""
  return `#/${path}${qs}`
}

export function routeTitle(id: RouteId): string {
  return routes[id].title
}

/** Breadcrumb ancestors (without the current page). */
export function routeAncestors(id: RouteId): RouteId[] {
  const trail: RouteId[] = []
  let current = (routes[id] as RouteDef).parent as RouteId | undefined
  while (current) {
    trail.unshift(current)
    current = ((routes[current] as RouteDef).parent as RouteId | undefined)
  }
  return trail
}

export interface NavigationItem {
  id: RouteId
  label: string
  icon: IconName
  /** Other routes that keep this item highlighted. */
  section: RouteId[]
}

export const citizenNav: NavigationItem[] = [
  { id: "dashboard", label: "ড্যাশবোর্ড", icon: "home", section: [] },
  {
    id: "applications",
    label: "আমার আবেদন",
    icon: "file",
    section: ["application", "new-application", "continue-application"],
  },
  { id: "records", label: "জমির রেকর্ড", icon: "map", section: ["record"] },
  { id: "documents", label: "নথিপত্র", icon: "folder", section: ["document"] },
  { id: "help", label: "সহায়তা", icon: "help", section: [] },
]

export const reviewerNav: NavigationItem[] = [
  { id: "queue", label: "পর্যালোচনার তালিকা", icon: "file", section: [] },
  { id: "desk", label: "নথি যাচাই", icon: "search", section: ["case"] },
  { id: "compare", label: "রেকর্ড মিলিয়ে দেখা", icon: "map", section: [] },
  { id: "lineage", label: "রেকর্ডের ইতিহাস", icon: "clock", section: [] },
]
