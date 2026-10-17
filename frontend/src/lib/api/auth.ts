import { apiPost, setCsrfToken, ApiError } from "./client"
import { sessionFromUser, setSession, isCurrentSessionDemo } from "./session"
import type {
  LoginInput,
  RegisterInput,
  Session,
  SessionResponse,
} from "./types"
import { mockLogin, mockRegister } from "@/mocks/auth"

/**
 * Authentication operations connected to BhoomiTrace backend.
 *
 * Uses:
 * - POST /api/v1/auth/login
 * - POST /api/v1/auth/register
 * - POST /api/v1/auth/logout
 */

export async function login(input: LoginInput): Promise<Session> {
  const email = input.email.trim().toLowerCase()

  if (isCurrentSessionDemo()) {
    return mockLogin({ email, password: input.password })
  }

  const res = await apiPost<SessionResponse>("/api/v1/auth/login", {
    email,
    password: input.password,
  })

  if (res.csrfToken) {
    setCsrfToken(res.csrfToken)
  }

  const session = sessionFromUser(res.user, false)
  setSession(session)
  return session
}

export async function register(input: RegisterInput): Promise<Session> {
  const email = input.email.trim().toLowerCase()
  const displayName = input.displayName.trim()

  if (isCurrentSessionDemo()) {
    return mockRegister({ email, displayName, password: input.password })
  }

  const res = await apiPost<SessionResponse>("/api/v1/auth/register", {
    email,
    displayName,
    password: input.password,
  })

  if (res.csrfToken) {
    setCsrfToken(res.csrfToken)
  }

  const session = sessionFromUser(res.user, false)
  setSession(session)
  return session
}

export async function requestPasswordReset(identifier: string): Promise<void> {
  void identifier
  // The backend contract intentionally does not offer an unauthenticated public password reset endpoint.
  // Administrative and operator accounts are managed via the CLI (`npm run db:admin -- --reset-password`).
  throw new ApiError(
    "পাসওয়ার্ড রিসেট অনলাইনে উপলব্ধ নয়। সিস্টেম প্রশাসকের সাথে যোগাযোগ করুন।",
    400,
    "feature_not_supported",
  )
}
