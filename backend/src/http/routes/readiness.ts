import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'

import { VALIDATION_RULES_VERSION } from '../../config/constants.js'
import type { User } from '../../db/schema/users.js'
import {
  generateReadinessReport,
  latestReadinessReport,
  listReadinessReportsForParcel,
  loadReadinessReport,
} from '../../services/readiness.js'
import { requireAuthenticated } from '../auth-context.js'
import {
  errorResponses,
  readinessReportSchema,
  uuidParam,
} from '../schemas.js'

/**
 * Mutation-readiness endpoints.
 *
 * A report is a checklist with reasons, not a score and not an approval. Each
 * item states its rule, its outcome, what was observed, what was expected, and
 * which records and evidence it points at. The overall outcome vocabulary is
 * administrative — `ready_for_review`, `needs_review`, `not_ready` — and the
 * summary text says in plain language that it is decision support only.
 *
 * Reports are effectively append-only: generating one inserts a new report and
 * leaves the previous ones intact, so the picture a decision was taken against
 * stays readable afterwards.
 */

function actor(request: FastifyRequest): User {
  return requireAuthenticated(request).user
}

export function readinessRoutes(app: FastifyInstance): void {
  const typed = app.withTypeProvider<ZodTypeProvider>()

  typed.get(
    '/parcels/:parcelId/readiness',
    {
      schema: {
        tags: ['readiness'],
        summary: 'List a parcel record’s readiness reports',
        description: 'Newest first, without their checklists.',
        params: uuidParam('parcelId'),
        response: {
          200: z.object({
            items: z.array(readinessReportSchema.omit({ items: true })),
          }),
          ...errorResponses,
        },
      },
    },
    async (request, reply) => {
      const items = await listReadinessReportsForParcel(
        app.database,
        actor(request),
        request.params.parcelId,
      )
      return reply.code(200).send({ items })
    },
  )

  typed.get(
    '/parcels/:parcelId/readiness/latest',
    {
      schema: {
        tags: ['readiness'],
        summary: 'The most recent readiness report for a parcel',
        description: 'Includes the full checklist. `404` when no report has been generated yet.',
        params: uuidParam('parcelId'),
        response: {
          200: readinessReportSchema,
          ...errorResponses,
        },
      },
    },
    async (request, reply) => {
      const report = await latestReadinessReport(
        app.database,
        actor(request),
        request.params.parcelId,
      )

      if (report === null) {
        // Reported through the standard envelope rather than as `null`, so a
        // caller cannot mistake "no report yet" for "nothing to report".
        return reply.code(404).send({
          error: {
            code: 'not_found',
            message: 'No readiness report has been generated for this parcel yet.',
            requestId: request.id,
          },
        })
      }

      return reply.code(200).send(report)
    },
  )

  typed.post(
    '/parcels/:parcelId/readiness',
    {
      schema: {
        tags: ['readiness'],
        summary: 'Generate a readiness report',
        description:
          'Evaluates the deterministic rule set and stores the result with its checklist. This is decision support: it is not an approval, it is not a legal opinion, and it makes no claim about ownership.',
        params: uuidParam('parcelId'),
        response: {
          201: readinessReportSchema,
          ...errorResponses,
        },
      },
    },
    async (request, reply) => {
      const report = await generateReadinessReport(app.database, {
        user: actor(request),
        parcelId: request.params.parcelId,
        rulesVersion: VALIDATION_RULES_VERSION,
        requestId: request.id,
      })

      return reply.code(201).send(report)
    },
  )

  typed.get(
    '/readiness-reports/:reportId',
    {
      schema: {
        tags: ['readiness'],
        summary: 'Read one readiness report',
        description:
          'Visibility follows the parcel, so a report identifier cannot be used to read another person’s record.',
        params: uuidParam('reportId'),
        response: {
          200: readinessReportSchema,
          ...errorResponses,
        },
      },
    },
    async (request, reply) => {
      const report = await loadReadinessReport(
        app.database,
        actor(request),
        request.params.reportId,
      )
      return reply.code(200).send(report)
    },
  )
}
