import type { FastifyInstance } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'

import { parsePagination } from '../../lib/pagination.js'
import { listAuditEvents } from '../../services/audit.js'
import { requireAuthenticatedWithRole } from '../auth-context.js'
import {
  auditEventSchema,
  auditListQuerySchema,
  errorResponses,
  pageOf,
} from '../schemas.js'

/**
 * Audit trail read endpoint.
 *
 * Administrators only, and read-only. There is no write endpoint and no delete
 * endpoint, because the database rejects `UPDATE` and `DELETE` on
 * `audit_events` by trigger: the trail can only be appended to, and only by the
 * service layer that accompanies a real change.
 *
 * The `changes` column has been redacted by key name on the way in, so a secret
 * cannot be sitting in a row waiting to be read out here.
 */
export function auditRoutes(app: FastifyInstance): void {
  const typed = app.withTypeProvider<ZodTypeProvider>()

  typed.get(
    '/audit-events',
    {
      schema: {
        tags: ['audit'],
        summary: 'Read the audit trail',
        description:
          'Newest first, filterable by entity, action, and actor. Administrators only.',
        querystring: auditListQuerySchema,
        response: {
          200: pageOf(auditEventSchema),
          ...errorResponses,
        },
      },
    },
    async (request, reply) => {
      requireAuthenticatedWithRole(request, 'admin')

      const page = await listAuditEvents(app.database, {
        ...(request.query.entityType === undefined
          ? {}
          : { entityType: request.query.entityType }),
        ...(request.query.entityId === undefined
          ? {}
          : { entityId: request.query.entityId }),
        ...(request.query.action === undefined ? {} : { action: request.query.action }),
        ...(request.query.actorId === undefined ? {} : { actorId: request.query.actorId }),
        pagination: parsePagination(request.query),
      })

      return reply.code(200).send(page)
    },
  )
}
