import type { FastifyInstance } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'

import { ValidationError } from '../../lib/errors.js'
import { checkPasswordPolicy } from '../../lib/password.js'
import {
  authenticateCredentials,
  createSession,
  registerApplicant,
  revokeSessionById,
  toPublicUser,
} from '../../services/auth.js'
import { AuditActions, recordAuditEvent } from '../../services/audit.js'
import {
  clearSessionCookies,
  cookieSettingsFromEnvironment,
  setSessionCookies,
} from '../cookies.js'
import { requireAuthenticated } from '../auth-context.js'
import {
  errorResponses,
  loginBodySchema,
  publicUserSchema,
  registerBodySchema,
  sessionResponseSchema,
} from '../schemas.js'

/**
 * Authentication endpoints.
 *
 * Registration always produces an `applicant`. There is no parameter, header,
 * or body field anywhere in this file that can influence the resulting role, so
 * a request cannot promote itself. Reviewer and administrator accounts are
 * created only by the bootstrap CLI or by an existing administrator.
 *
 * Sessions are server-side. The cookie carries an opaque token whose digest is
 * what the database holds, so a stolen cookie can be revoked and a database
 * dump cannot be replayed. Login failures are indistinguishable from each other
 * in both content and timing — see the auth service.
 */

export function authRoutes(app: FastifyInstance): void {
  const typed = app.withTypeProvider<ZodTypeProvider>()
  const env = app.appEnv
  const settings = cookieSettingsFromEnvironment(env)

  const authRateLimit = {
    rateLimit: {
      max: env.AUTH_RATE_LIMIT_MAX,
      timeWindow: env.AUTH_RATE_LIMIT_WINDOW_MINUTES * 60 * 1_000,
    },
  }

  typed.post(
    '/auth/register',
    {
      config: authRateLimit,
      schema: {
        tags: ['auth'],
        summary: 'Register an applicant account',
        description:
          'Creates an account with the `applicant` role. No request field can influence the role; reviewer and administrator accounts are created out of band.',
        body: registerBodySchema,
        response: {
          201: sessionResponseSchema,
          ...errorResponses,
        },
      },
    },
    async (request, reply) => {
      const policy = checkPasswordPolicy(request.body.password)
      if (!policy.ok) {
        // The message states the rule, never the value, and never a hash.
        throw new ValidationError(policy.message ?? 'Password rejected.')
      }

      const user = await registerApplicant(app.database, {
        email: request.body.email,
        password: request.body.password,
        displayName: request.body.displayName,
      })

      const session = await createSession(
        app.database,
        user.id,
        { ttlHours: env.AUTH_SESSION_TTL_HOURS },
        { userAgent: request.headers['user-agent'] ?? null },
      )

      setSessionCookies(reply, settings, {
        sessionToken: session.token,
        csrfToken: session.csrfToken,
      })

      return reply.code(201).send({
        user,
        csrfToken: session.csrfToken,
        expiresAt: session.session.expiresAt.toISOString(),
      })
    },
  )

  typed.post(
    '/auth/login',
    {
      config: authRateLimit,
      schema: {
        tags: ['auth'],
        summary: 'Sign in',
        description:
          'Exchanges credentials for a server-side session. An unknown account and a wrong password produce the same response.',
        body: loginBodySchema,
        response: {
          200: sessionResponseSchema,
          ...errorResponses,
        },
      },
    },
    async (request, reply) => {
      const user = await authenticateCredentials(app.database, {
        email: request.body.email,
        password: request.body.password,
        requestId: request.id,
      })

      const session = await createSession(
        app.database,
        user.id,
        { ttlHours: env.AUTH_SESSION_TTL_HOURS },
        { userAgent: request.headers['user-agent'] ?? null },
      )

      setSessionCookies(reply, settings, {
        sessionToken: session.token,
        csrfToken: session.csrfToken,
      })

      return reply.code(200).send({
        user: toPublicUser(user),
        csrfToken: session.csrfToken,
        expiresAt: session.session.expiresAt.toISOString(),
      })
    },
  )

  typed.post(
    '/auth/logout',
    {
      schema: {
        tags: ['auth'],
        summary: 'Sign out',
        description:
          'Deletes the server-side session, so the cookie is worthless afterwards, and clears both cookies.',
        response: {
          204: z.null(),
          ...errorResponses,
        },
      },
    },
    async (request, reply) => {
      const context = requireAuthenticated(request)

      // Delete the row first: clearing a cookie alone would leave a working
      // session behind for anybody who had copied the token.
      await revokeSessionById(app.database, context.session.id)
      clearSessionCookies(reply, settings)

      await recordAuditEvent(app.database.orm, {
        actor: {
          kind: 'user',
          userId: context.user.id,
          role: context.user.role,
        },
        action: AuditActions.logout,
        entityType: 'auth_session',
        entityId: context.session.id,
        summary: 'Session ended by the account holder.',
        requestId: request.id,
      })

      return reply.code(204).send(null)
    },
  )

  typed.get(
    '/auth/me',
    {
      schema: {
        tags: ['auth'],
        summary: 'Current account',
        description:
          'Returns the signed-in account. The CSRF token is not returned here, because only its digest is stored; it is issued once at login.',
        response: {
          200: publicUserSchema,
          ...errorResponses,
        },
      },
    },
    async (request, reply) => {
      const context = requireAuthenticated(request)
      return reply.code(200).send(toPublicUser(context.user))
    },
  )
}
