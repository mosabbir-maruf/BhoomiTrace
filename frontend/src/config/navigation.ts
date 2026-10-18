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
  /** Search-engine-optimized full page title override. */
  seoTitle?: string
  /** Search engine meta description. */
  description?: string
}

export const routes = {
  landing: {
    path: "",
    title: "BhoomiTrace",
    seoTitle: "BhoomiTrace — ভূমিট্রেস | ভূমি রেকর্ড যাচাই, খতিয়ান ও আবেদন ট্র্যাকিং",
    description: "BhoomiTrace (ভূমিট্রেস): পুরোনো ভূমি নথির খতিয়ান, দাগ ও মৌজা রেকর্ড মিলিয়ে দেখার এবং আবেদন ট্র্যাকিং করার আধুনিক ডিজিটাল প্রোটোটাইপ প্ল্যাটফর্ম।",
    audience: "public",
  },
  login: {
    path: "login",
    title: "লগইন",
    seoTitle: "লগইন | BhoomiTrace — ভূমি রেকর্ড ও আবেদন ট্র্যাকিং",
    description: "BhoomiTrace পোর্টালে আপনার অ্যাকাউন্টে লগইন করুন এবং খতিয়ান, দাগ ও ভূমি আবেদন ট্র্যাক করুন।",
    audience: "public",
  },
  register: {
    path: "register",
    title: "নতুন অ্যাকাউন্ট",
    seoTitle: "নতুন অ্যাকাউন্ট নিবন্ধন | BhoomiTrace",
    description: "BhoomiTrace-এ নতুন নাগরিক বা নিরীক্ষক অ্যাকাউন্ট তৈরি করুন। দ্রুত ও সহজে জমি রেকর্ড যাচাই সেবা নিন।",
    audience: "public",
  },
  "forgot-password": {
    path: "forgot-password",
    title: "পাসওয়ার্ড পুনরুদ্ধার",
    seoTitle: "পাসওয়ার্ড পুনরুদ্ধার | BhoomiTrace",
    description: "আপনার BhoomiTrace অ্যাকাউন্টের পাসওয়ার্ড সহজে পুনরুদ্ধার বা রিসেট করুন।",
    audience: "public",
  },
  enter: {
    path: "demo/:id",
    title: "ডেমোতে প্রবেশ",
    seoTitle: "লাইভ ডেমো পরিবেশ | BhoomiTrace",
    description: "নাগরিক এবং পর্যালোচক হিসেবে BhoomiTrace-এর কার্যপ্রণালীর সরাসরি ডেমো ইন্টারফেস অভিজ্ঞতা নিন।",
    audience: "public",
  },

  dashboard: {
    path: "dashboard",
    title: "আমার ড্যাশবোর্ড",
    seoTitle: "নাগরিক ড্যাশবোর্ড | BhoomiTrace",
    description: "আপনার সাম্প্রতিক ভূমি আবেদন, নথিপত্র এবং রেকর্ড স্ট্যাটাস একনজরে পর্যালোচনা করুন।",
    audience: "citizen",
  },
  applications: {
    path: "applications",
    title: "আমার আবেদন",
    seoTitle: "আমার ভূমি আবেদনসমূহ | BhoomiTrace",
    description: "জমি জমা ও রেকর্ড সংশোধন সংক্রান্ত আপনার সকল চলমান এবং সম্পন্ন আবেদনের বিস্তারিত তালিকা।",
    audience: "citizen",
    parent: "dashboard",
  },
  application: {
    path: "applications/:id",
    title: "আবেদনের বিস্তারিত",
    seoTitle: "আবেদনের বিস্তারিত তথ্য ও অগ্রগতি | BhoomiTrace",
    description: "নির্দিষ্ট ভূমি আবেদনের বর্তমান স্ট্যাটাস, প্রয়োজনীয় নথিপত্র এবং নিরীক্ষকের পর্যালোচনার ফলাফল।",
    audience: "citizen",
    parent: "applications",
  },
  "new-application": {
    path: "new-application",
    title: "নতুন আবেদন",
    seoTitle: "নতুন ভূমি আবেদন দাখিল | BhoomiTrace",
    description: "খতিয়ান সংশোধন, রেকর্ড যাচাই বা শুনানির জন্য সহজ ৪ ধাপে নতুন আবেদন সম্পন্ন করুন।",
    audience: "citizen",
    parent: "applications",
  },
  "continue-application": {
    path: "new-application/:id",
    title: "খসড়া আবেদন",
    seoTitle: "সংরক্ষিত খসড়া আবেদন সম্পাদনা | BhoomiTrace",
    description: "পূর্বে সংরক্ষিত খসড়া ভূমি আবেদন পর্যালোচনা ও পরবর্তী ধাপে দাখিল করুন।",
    audience: "citizen",
    parent: "applications",
  },
  records: {
    path: "records",
    title: "জমির রেকর্ড",
    seoTitle: "জমির রেকর্ড অনুসন্ধান ও তালিকা | BhoomiTrace",
    description: "মৌজা, খতিয়ান ও দাগ নম্বর দিয়ে আরএস, সিএস ও বিএস জরিপ রেকর্ড মিলিয়ে দেখুন ও বিশ্লেষণ করুন।",
    audience: "citizen",
    parent: "dashboard",
  },
  record: {
    path: "records/:id",
    title: "রেকর্ডের বিস্তারিত",
    seoTitle: "জমির রেকর্ডের পুঙ্খানুপুঙ্খ তথ্য | BhoomiTrace",
    description: "নির্বাচিত দাগ ও খতিয়ানের বিস্তারিত জরিপ তথ্য, মালিকানা বিবরণ এবং উৎসের প্রমাণ।",
    audience: "citizen",
    parent: "records",
  },
  documents: {
    path: "documents",
    title: "নথিপত্র",
    seoTitle: "ভূমি নথিপত্র ও দলিলের ডিজিটাল সংগ্রহ | BhoomiTrace",
    description: "আপনার সংরক্ষিত দলিলের স্ক্যান কপি, পরচা ও সরকারি রেকর্ডের নিরাপদ ডিজিটাল সংরক্ষণাগার।",
    audience: "citizen",
    parent: "dashboard",
  },
  document: {
    path: "documents/:id",
    title: "নথির বিস্তারিত",
    seoTitle: "নথির বিস্তারিত ও প্রমাণ ম্যাপিং | BhoomiTrace",
    description: "নথির স্ক্যান পাতা থেকে সরাসরি এক্সট্র্যাক্ট করা খতিয়ান ও দাগ তথ্যের ভিজ্যুয়াল ম্যাপিং।",
    audience: "citizen",
    parent: "documents",
  },

  help: {
    path: "help",
    title: "সহায়তা",
    seoTitle: "সহায়তা ও সাধারণ নির্দেশিকা (FAQ) | BhoomiTrace",
    description: "খতিয়ান, দাগ, মৌজার অর্থ বুঝুন এবং প্ল্যাটফর্ম ব্যবহারের প্রশ্নোত্তরের সহায়তা পান।",
    audience: "signed-in",
  },
  profile: {
    path: "profile",
    title: "আমার প্রোফাইল",
    seoTitle: "ব্যবহারকারী প্রোফাইল ও সেটিংস | BhoomiTrace",
    description: "আপনার ব্যক্তিগত তথ্য, মোবাইল নম্বর এবং অ্যাকাউন্টের নিরাপত্তা সেটিংস পরিচালনা করুন।",
    audience: "signed-in",
  },

  queue: {
    path: "reviewer",
    title: "পর্যালোচনার তালিকা",
    seoTitle: "পর্যালোচনার তালিকা (Reviewer Queue) | BhoomiTrace",
    description: "যাচাইকারী কর্মকর্তার পর্যালোচনার অপেক্ষায় থাকা আবেদন ও নথিপত্রের তালিকা।",
    audience: "reviewer",
  },
  desk: {
    path: "reviewer/cases",
    title: "নথি যাচাই",
    seoTitle: "নথি যাচাই ও নিরীক্ষা ডেস্ক | BhoomiTrace",
    description: "মূল নথির সাথে এক্সট্র্যাক্ট করা তথ্যের তুলনা এবং নির্ভুল নিরীক্ষা সিদ্ধান্ত প্রদান।",
    audience: "reviewer",
    parent: "queue",
  },
  case: {
    path: "reviewer/cases/:id",
    title: "নথি যাচাই",
    seoTitle: "নথি নিরীক্ষা কেস বিবরণ | BhoomiTrace",
    description: "নির্দিষ্ট মামলার নথি ও তথ্যের পুঙ্খানুপুঙ্খ এভিডেন্স যাচাই।",
    audience: "reviewer",
    parent: "queue",
  },
  compare: {
    path: "reviewer/compare",
    title: "রেকর্ড মিলিয়ে দেখা",
    seoTitle: "বিভিন্ন জরিপের রেকর্ড তুলনা (Compare) | BhoomiTrace",
    description: "সিএস, আরএস ও বিএস খতিয়ানের তথ্যের গরমিল এবং দাগের তারতম্য পাশাপাশি মিলিয়ে দেখুন।",
    audience: "reviewer",
    parent: "queue",
  },
  lineage: {
    path: "reviewer/lineage",
    title: "রেকর্ডের ইতিহাস",
    seoTitle: "জমির রেকর্ডের ইতিহাস ও বংশপরম্পরা (Lineage) | BhoomiTrace",
    description: "জমির মালিকানা হস্তান্তর, খতিয়ানের পরিবর্তন ও ঐতিহাসিক জরিপের বংশপরম্পরা গ্রাফ।",
    audience: "reviewer",
    parent: "queue",
  },

  "not-found": {
    path: "404",
    title: "পাতা পাওয়া যায়নি",
    seoTitle: "পাতা পাওয়া যায়নি (404) | BhoomiTrace",
    description: "অনুরোধকৃত পাতাটি পাওয়া যায়নি। অনুগ্রহ করে সঠিক লিংক ব্যবহার করুন বা মূল পাতায় ফিরে যান।",
    audience: "public",
  },
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

export function routeSeoTitle(id: RouteId): string {
  return routes[id].seoTitle ?? `${routes[id].title} | BhoomiTrace`
}

export function routeDescription(id: RouteId): string {
  return (
    routes[id].description ??
    "BhoomiTrace: পুরোনো ভূমি নথির খতিয়ান, দাগ ও মৌজা রেকর্ড মিলিয়ে দেখার আধুনিক ডিজিটাল প্ল্যাটফর্ম প্রোটোটাইপ।"
  )
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
