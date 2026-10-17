// Imported for its type augmentation only: `@fastify/cookie` adds
// `reply.setCookie` / `reply.clearCookie` and `request.cookies` to Fastify's
// interfaces. A side-effect import guarantees the augmentation is part of the
// program even in a file that never registers the plugin itself.
import '@fastify/cookie'

import type { FastifyReply } from 'fastify'

import {
  CSRF_COOKIE_NAME,
  SESSION_COOKIE_NAME,
} from '../config/constants.js'
import type { Environment } from '../config/env.js'
import { useSecureCookies } from '../config/env.js'

/**
 * Session and CSRF cookie handling.
 *
 * The session cookie is HTTP-only, so a cross-site scripting bug cannot read it.
 * The CSRF cookie is deliberately readable, because the browser client must echo
 * its value in a header; it is only accepted together with a session whose
 * stored digest matches. Neither cookie is ever logged or returned in a body.
 */

export interface CookieSettings {
  secure: boolean
  sessionTtlSeconds: number
}

export function cookieSettingsFromEnvironment(env: Environment): CookieSettings {
  return {
    secure: useSecureCookies(env),
    sessionTtlSeconds: env.AUTH_SESSION_TTL_HOURS * 60 * 60,
  }
}

/**
 * Sets both cookies for a new session.
 *
 * `SameSite=Lax` is used rather than `Strict` so that following a link into the
 * application still presents a session; the CSRF token, not the cookie policy,
 * is what protects state-changing requests. `Path=/` is explicit so the cookie
 * scope cannot change by accident.
 */
export function setSessionCookies(
  reply: FastifyReply,
  settings: CookieSettings,
  tokens: { sessionToken: string; csrfToken: string },
): void {
  reply.setCookie(SESSION_COOKIE_NAME, tokens.sessionToken, {
    path: '/',
    httpOnly: true,
    secure: settings.secure,
    sameSite: 'lax',
    maxAge: settings.sessionTtlSeconds,
  })

  reply.setCookie(CSRF_COOKIE_NAME, tokens.csrfToken, {
    path: '/',
    httpOnly: false,
    secure: settings.secure,
    sameSite: 'lax',
    maxAge: settings.sessionTtlSeconds,
  })
}

/** Clears both cookies. Attributes must match, or the browser keeps them. */
export function clearSessionCookies(
  reply: FastifyReply,
  settings: CookieSettings,
): void {
  for (const name of [SESSION_COOKIE_NAME, CSRF_COOKIE_NAME]) {
    reply.clearCookie(name, {
      path: '/',
      httpOnly: name === SESSION_COOKIE_NAME,
      secure: settings.secure,
      sameSite: 'lax',
    })
  }
}
