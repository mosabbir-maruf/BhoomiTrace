import { lazy, Suspense, useEffect, useState, type ComponentType } from "react"
import ErrorBoundary from "@/components/ErrorBoundary"
import AppShell from "@/components/shell/AppShell"
import { buttonClasses } from "@/components/ui/Button"
import { LoadingRegion, Skeleton } from "@/components/ui/States"
import {
  routeHref,
  routes,
  type Route,
  type RouteId,
} from "@/config/navigation"
import { navigate, useRoute } from "@/hooks/useHashRoute"
import { usePageSeo } from "@/hooks/usePageSeo"
import { restoreSession, startDemo, useSession } from "@/lib/api/session"
import { reviewCases } from "@/mocks/evidence"
import LandingPage from "@/features/public/LandingPage"

const LoginPage = lazy(() => import("@/features/auth/LoginPage"))
const RegisterPage = lazy(() => import("@/features/auth/RegisterPage"))
const ForgotPasswordPage = lazy(
  () => import("@/features/auth/ForgotPasswordPage"),
)
const EvidenceDesk = lazy(() => import("@/features/evidence/EvidenceDesk"))
const QueuePage = lazy(() => import("@/features/reviewer/QueuePage"))
const ComparePage = lazy(() => import("@/features/reviewer/ComparePage"))
const LineagePage = lazy(() => import("@/features/reviewer/LineagePage"))
const Dashboard = lazy(() => import("@/features/citizen/Dashboard"))
const ApplicationsPage = lazy(
  () => import("@/features/citizen/ApplicationsPage"),
)
const ApplicationDetail = lazy(
  () => import("@/features/citizen/ApplicationDetail"),
)
const NewApplication = lazy(() => import("@/features/citizen/NewApplication"))
const RecordsPage = lazy(() => import("@/features/citizen/RecordsPage"))
const RecordDetail = lazy(() => import("@/features/citizen/RecordDetail"))
const DocumentsPage = lazy(() => import("@/features/citizen/DocumentsPage"))
const DocumentDetail = lazy(() => import("@/features/citizen/DocumentDetail"))
const HelpPage = lazy(() => import("@/features/citizen/HelpPage"))
const ProfilePage = lazy(() => import("@/features/citizen/ProfilePage"))

/** Pages that render inside the signed-in shell. Detail pages read their ID from the route. */
const shellPages: Partial<Record<RouteId, ComponentType>> = {
  dashboard: Dashboard,
  applications: ApplicationsPage,
  application: ApplicationDetail,
  "new-application": NewApplication,
  "continue-application": NewApplication,
  records: RecordsPage,
  record: RecordDetail,
  documents: DocumentsPage,
  document: DocumentDetail,
  help: HelpPage,
  profile: ProfilePage,
  queue: QueuePage,
  compare: ComparePage,
  lineage: LineagePage,
}

const publicPages: Partial<Record<RouteId, ComponentType>> = {
  login: LoginPage,
  register: RegisterPage,
  "forgot-password": ForgotPasswordPage,
}

const fallback = (
  <div className="page-width py-10">
    <LoadingRegion label="পাতা খোলা হচ্ছে…">
      <Skeleton className="h-10 w-64" />
    </LoadingRegion>
  </div>
)

function Boundary({
  route,
  children,
}: {
  route: Route
  children: React.ReactNode
}) {
  const key = `${route.id}:${route.param ?? ""}`
  return (
    <ErrorBoundary resetKey={key}>
      <Suspense fallback={fallback}>{children}</Suspense>
    </ErrorBoundary>
  )
}

function Message({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <div className="page-width py-16">
      <div className="max-w-xl">
        <h1 tabIndex={-1} className="text-3xl font-semibold">
          {title}
        </h1>
        <div className="mt-3 space-y-4 text-lg text-ink-muted">{children}</div>
      </div>
    </div>
  )
}

/** Opens a demo from a shareable link such as #/demo/reviewer. */
function EnterDemo({ role }: { role?: string }) {
  useEffect(() => {
    if (role === "citizen" || role === "reviewer") {
      startDemo(role)
      navigate(routeHref(role === "citizen" ? "dashboard" : "queue"), {
        replace: true,
      })
    } else navigate(routeHref("login"), { replace: true })
  }, [role])
  return fallback
}

function RedirectToLogin() {
  // Capture the requested page once; the effect can run twice in development.
  const [next] = useState(() => window.location.hash)
  useEffect(() => {
    navigate(routeHref("login", undefined, { reason: "required", next }), {
      replace: true,
    })
  }, [next])
  return fallback
}

function NotFound() {
  return (
    <Message title="পাতাটি পাওয়া যায়নি">
      <p>লিংকটি ভুল হতে পারে, অথবা এই কাল্পনিক তথ্য ডেমোতে নেই।</p>
      <a className={buttonClasses()} href={routeHref("landing")}>
        প্রথম পাতায় যান
      </a>
    </Message>
  )
}

export default function App() {
  const route = useRoute()
  usePageSeo(route)
  const session = useSession()
  const [checkingAuth, setCheckingAuth] = useState(!session)
  const def = routes[route.id]

  useEffect(() => {
    restoreSession().finally(() => {
      setCheckingAuth(false)
    })
  }, [])

  if (route.id === "landing") return <LandingPage />
  if (route.id === "enter") return <EnterDemo role={route.param} />
  if (route.id === "not-found")
    return session ? (
      <AppShell route={route.id} pageKey="not-found" audience={session.role}>
        <NotFound />
      </AppShell>
    ) : (
      <main id="main">
        <NotFound />
      </main>
    )

  const Public = publicPages[route.id]
  if (Public)
    return (
      <Boundary route={route}>
        <Public />
      </Boundary>
    )

  if (checkingAuth && !session) return fallback
  if (!session) return <RedirectToLogin />

  const audience = session.role
  const pageKey = `${route.id}:${route.param ?? ""}`

  // Audience checks are a demo convenience, not access control.
  if (def.audience !== "signed-in" && def.audience !== session.role) {
    const needed = def.audience === "reviewer" ? "reviewer" : "citizen"
    return (
      <AppShell route={route.id} pageKey={pageKey} audience={audience}>
        <Message
          title={needed === "reviewer" ? "এটি পর্যালোচকের পাতা" : "এটি নাগরিকের পাতা"}
        >
          <p>
            আপনি এখন {session.role === "citizen" ? "নাগরিক" : "পর্যালোচক"} ডেমোতে
            আছেন। এই পাতা দেখতে ভূমিকা বদলান।
          </p>
          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              className={buttonClasses()}
              onClick={() => startDemo(needed)}
            >
              {needed === "reviewer" ? "পর্যালোচক ডেমোতে যান" : "নাগরিক ডেমোতে যান"}
            </button>
            <a
              className={buttonClasses("secondary")}
              href={routeHref(
                session.role === "citizen" ? "dashboard" : "queue",
              )}
            >
              আমার শুরুর পাতা
            </a>
          </div>
        </Message>
      </AppShell>
    )
  }

  let screen: React.ReactNode
  if (route.id === "desk" || route.id === "case") {
    const caseId = route.param ?? reviewCases[0].id
    screen = reviewCases.some((c) => c.id === caseId) ? (
      <EvidenceDesk key={caseId} caseId={caseId} />
    ) : (
      <NotFound />
    )
  } else {
    const Screen = shellPages[route.id]
    screen = Screen ? <Screen key={pageKey} /> : <NotFound />
  }

  return (
    <AppShell route={route.id} pageKey={pageKey} audience={audience}>
      <Boundary route={route}>{screen}</Boundary>
    </AppShell>
  )
}
