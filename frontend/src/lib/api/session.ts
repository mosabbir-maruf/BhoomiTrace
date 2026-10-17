import { useSyncExternalStore } from "react"
import { apiGet, apiPost, setCsrfToken } from "./client"
import type { DemoRole, PublicUser, Session } from "./types"
import { demoPersonas } from "@/mocks/auth"

/**
 * Authentication and session state.
 *
 * Real sessions are server-side and carried in the HTTP-only `bt_session` cookie
 * and readable `bt_csrf` cookie. No password or secret token is ever stored in
 * localStorage or sessionStorage.
 */

const KEY = "bhoomitrace-session-user"
const listeners = new Set<() => void>()

function loadCachedUser(): Session | null {
  try {
    const raw = sessionStorage.getItem(KEY)
    if (!raw) return null
    const val = JSON.parse(raw) as Session
    return val && val.id ? val : null
  } catch {
    return null
  }
}

let session: Session | null =
  typeof window === "undefined" ? null : loadCachedUser()
let isRestoring = false

function emit() {
  listeners.forEach((l) => l())
}

export function setSession(next: Session | null) {
  session = next
  try {
    if (next) {
      sessionStorage.setItem(KEY, JSON.stringify(next))
    } else {
      sessionStorage.removeItem(KEY)
    }
  } catch {
    // Storage can be unavailable in private browsing mode
  }
  emit()
}

/** Converts a backend PublicUser into the frontend Session object. */
export function sessionFromUser(user: PublicUser, isDemo = false): Session {
  const role =
    user.role === "applicant" ? "citizen" : user.role as "reviewer" | "admin"
  return {
    user,
    role,
    displayName: user.displayName,
    email: user.email,
    id: user.id,
    accountId: user.email,
    isDemo,
  }
}

/**
 * Restores the server-side session by querying GET /api/v1/auth/me.
 * If active, updates the session state and returns the session.
 * If expired or unauthorized, clears the session.
 */
export async function restoreSession(): Promise<Session | null> {
  if (isRestoring) return session
  isRestoring = true
  try {
    const user = await apiGet<PublicUser>("/api/v1/auth/me")
    const restored = sessionFromUser(user, false)
    setSession(restored)
    return restored
  } catch {
    // If not authenticated on backend:
    // If current session was explicitly a local demo session, keep it, otherwise clear it
    if (session?.isDemo) {
      return session
    }
    setSession(null)
    setCsrfToken(null)
    return null
  } finally {
    isRestoring = false
  }
}

/** Explicitly starts an isolated client-side demo persona. */
export function startDemo(role: DemoRole) {
  const persona = demoPersonas[role]
  const demoSession: Session = {
    user: {
      id: `demo-${role}`,
      email: persona.identifier,
      displayName: persona.session.displayName,
      role: role === "citizen" ? "applicant" : "reviewer",
      status: "active",
      createdAt: new Date().toISOString(),
    },
    role,
    displayName: persona.session.displayName,
    email: persona.identifier,
    id: `demo-${role}`,
    accountId: persona.session.accountId,
    isDemo: true,
  }
  setSession(demoSession)
}

/** Signs out by calling the backend logout endpoint and clearing session state. */
export async function signOut(): Promise<void> {
  if (session && !session.isDemo) {
    try {
      await apiPost<void>("/api/v1/auth/logout")
    } catch {
      // Ignore network errors on logout to allow local cleanup
    }
  }
  setCsrfToken(null)
  setSession(null)
}

export function useSession(): Session | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => session,
    () => null,
  )
}

/** Returns true when the active session is a real authenticated backend session. */
export function isCurrentSessionLive(): boolean {
  return Boolean(session && !session.isDemo)
}

/** Returns true when the active session is an explicit client-side demo session. */
export function isCurrentSessionDemo(): boolean {
  return Boolean(session?.isDemo || session?.demo)
}

/** Returns true only when the active session was explicitly initiated as a demo session. */
export function isDemoMode(): boolean {
  return Boolean(session?.isDemo || session?.demo)
}

export const isLiveData = true

/**
 * A key that changes whenever session identity changes.
 * Data hooks use it as a reload dependency.
 */
export function useDataSourceKey(): string {
  const s = useSession()
  return s ? `${s.id}-${s.role}` : "anonymous"
}
