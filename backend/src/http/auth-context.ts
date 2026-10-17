import type { FastifyInstance, FastifyRequest } from 'fastify'

import {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  SESSION_COOKIE_NAME,
} from '../config/constants.js'
import type { AuthSession } from '../db/schema/sessions.js'
import type { UserRole } from '../db/schema/enums.js'
import type { User } from '../db/schema/users.js'
import { ForbiddenError, UnauthorizedError } from '../lib/errors.js'
import { csrfTokenMatches, resolveSessionToken } from '../services/auth.js'
import { clearSessionCookies, type CookieSettings } from './cookies.js'

/**
 * Central authentication and authorization.
 *
 * Identity is resolved once per request from the session cookie against the
 * database. Nothing about the caller's role or ownership is ever read from a
 * header, query parameter, or body: those are inputs a client controls, so they
 * can only ever *select* a resource, never authorise access to it.
 *
 * Two guards protect state-changing requests:
 *
 * 1. **Origin allowlist.** If the browser sent an `Origin`, it must be one we
 *    serve. A cross-site `fetch` always carries the attacker's origin, so it is
 *    rejected here. Requests with no `Origin` at all (curl, server-to-server,
 *    the test client) are not cross-site browser requests and are judged by the
 *    CSRF rule instead.
 * 2. **Synchronizer CSRF token.** When the request carries a session cookie, a
 *    matching `x-csrf-token` header is required. The token is bound to that
 *    session's stored digest, so a token minted for another session cannot be
 *    replayed. CORS alone does not prevent CSRF, which is why this exists.
 */

declare module 'fastify' {
  interface FastifyRequest {
    /** Present when the request carried a valid, active session cookie. */
    authContext?: AuthContext
  }
}

export interface AuthContext {
  user: User
  session: AuthSession
}

const STATE_CHANGING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

export interface AuthResolutionOptions {
  settings: CookieSettings
  allowedOrigins: readonly string[]
}

function isApiRequest(request: FastifyRequest): boolean {
  return request.url.startsWith('/api/')
}

function readCookie(request: FastifyRequest, name: string): string | undefined {
  const cookies = request.cookies as Record<string, string | undefined> | undefined
  const value = cookies?.[name]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function assertOriginAllowed(
  request: FastifyRequest,
  allowedOrigins: readonly string[],
): void {
  const origin = request.headers.origin
  if (typeof origin !== 'string' || origin.length === 0) return
  if (!allowedOrigins.includes(origin)) {
    throw new ForbiddenError('This request origin is not allowed.')
  }
}

function assertCsrfToken(request: FastifyRequest): void {
  const context = request.authContext
  // No session cookie means no cookie-authenticated state to forge. Login and
  // registration are guarded by the origin rule above.
  if (context === undefined) return

  const header = request.headers[CSRF_HEADER_NAME]
  if (typeof header !== 'string' || header.length === 0) {
    throw new ForbiddenError(
      'A CSRF token is required. Send it in the x-csrf-token header.',
    )
  }

  const cookie = readCookie(request, CSRF_COOKIE_NAME)
  if (cookie === undefined || cookie !== header) {
    throw new ForbiddenError('The CSRF token does not match the session.')
  }

  if (!csrfTokenMatches(context.session, header)) {
    throw new ForbiddenError('The CSRF token does not match the session.')
  }
}

/**
 * Installs identity resolution and request-forgery protection.
 *
 * Called on the root instance so the hooks apply to every `/api` route without
 * each one opting in. Route handlers then decide *authorization* explicitly via
 * `requireAuthenticated` / `requireRole`; nothing is protected merely by being
 * registered.
 */
export function registerAuthResolution(
  app: FastifyInstance,
  options: AuthResolutionOptions,
): void {
  app.addHook('onRequest', async (request, reply) => {
    if (!isApiRequest(request)) return

    const token = readCookie(request, SESSION_COOKIE_NAME)
    if (token === undefined) return

    const resolution = await resolveSessionToken(app.database, token)

    if (resolution.outcome === 'active') {
      request.authContext = {
        user: resolution.user,
        session: resolution.session,
      }
      return
    }

    // Unknown, expired, or suspended: drop the cookies so the client stops
    // presenting a dead session and re-authenticates.
    clearSessionCookies(reply, options.settings)
  })

  app.addHook('onRequest', async (request) => {
    if (!isApiRequest(request)) return
    if (!STATE_CHANGING_METHODS.has(request.method)) return

    assertOriginAllowed(request, options.allowedOrigins)
    assertCsrfToken(request)
  })
}

/** Returns the authenticated context, or rejects with 401. */
export function requireAuthenticated(request: FastifyRequest): AuthContext {
  const context = request.authContext
  if (context === undefined) {
    throw new UnauthorizedError('Sign in to continue.')
  }
  return context
}

/** Rejects with 403 unless the user holds one of the given roles. */
export function requireRole(user: User, ...roles: readonly UserRole[]): void {
  if (!roles.includes(user.role)) {
    throw new ForbiddenError('Your role is not permitted to perform this action.')
  }
}

/** Convenience for the common "signed in and holds a role" case. */
export function requireAuthenticatedWithRole(
  request: FastifyRequest,
  ...roles: readonly UserRole[]
): AuthContext {
  const context = requireAuthenticated(request)
  requireRole(context.user, ...roles)
  return context
}

/**
 * The audit actor for a signed-in user.
 *
 * Kept here so that every route records the actor the same way, with the role
 * snapshotted at the time of the action.
 */
export function auditActorFor(
  user: User,
): { kind: 'user'; userId: string; role: UserRole } {
  return { kind: 'user', userId: user.id, role: user.role }
}
