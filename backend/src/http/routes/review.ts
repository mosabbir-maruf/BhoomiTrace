import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'

import type { User } from '../../db/schema/users.js'
import { loadVisibleExtraction, toExtractionView } from '../../services/extractions.js'
import {
  listDecisionsForExtraction,
  listDecisionsForFinding,
  loadFindingDetail,
  loadReviewQueue,
  reviewExtraction,
  reviewFinding,
  toFindingView,
} from '../../services/review.js'
import { requireAuthenticated, requireRole } from '../auth-context.js'
import {
  errorResponses,
  extractionSchema,
  findingSchema,
  reviewDecisionSchema,
  reviewExtractionBodySchema,
  reviewFindingBodySchema,
  reviewQueueQuerySchema,
  reviewQueueSchema,
  uuidParam,
} from '../schemas.js'

/**
 * Reviewer workflow endpoints.
 *
 * A review decision is appended, never edited: correcting an earlier decision
 * adds another entry, and the database rejects `UPDATE` and `DELETE` on
 * `review_decisions` outright. Both review routes require the `version` the
 * reviewer last read, so two reviewers working on the same item cannot silently
 * overwrite each other.
 *
 * Read routes are open to whoever can see the underlying parcel — an applicant
 * can follow what happened to their own filing — while the queue and the
 * decisions themselves are restricted to reviewers and administrators.
 */

function actor(request: FastifyRequest): User {
  return requireAuthenticated(request).user
}

export function reviewRoutes(app: FastifyInstance): void {
  const typed = app.withTypeProvider<ZodTypeProvider>()

  typed.get(
    '/review/queue',
    {
      schema: {
        tags: ['review'],
        summary: 'The reviewer work queue',
        description:
          'Values awaiting a decision and findings still open, newest first and bounded by `limit`. Both sides are paginated independently with `offset`.',
        querystring: reviewQueueQuerySchema,
        response: {
          200: reviewQueueSchema,
          ...errorResponses,
        },
      },
    },
    async (request, reply) => {
      requireRole(actor(request), 'reviewer', 'admin')

      const queue = await loadReviewQueue(app.database, {
        limit: request.query.limit,
        offset: request.query.offset,
        ...(request.query.parcelId === undefined
          ? {}
          : { parcelId: request.query.parcelId }),
        ...(request.query.severity === undefined
          ? {}
          : { severity: request.query.severity }),
        ...(request.query.extractionStatus === undefined
          ? {}
          : { extractionStatus: request.query.extractionStatus }),
      })

      return reply.code(200).send(queue)
    },
  )

  typed.get(
    '/extractions/:extractionId',
    {
      schema: {
        tags: ['extractions'],
        summary: 'Read one extracted value',
        description:
          'Visibility follows the parcel, so an extraction identifier cannot be used to reach another person’s record.',
        params: uuidParam('extractionId'),
        response: {
          200: extractionSchema,
          ...errorResponses,
        },
      },
    },
    async (request, reply) => {
      const extraction = await loadVisibleExtraction(
        app.database,
        actor(request),
        request.params.extractionId,
      )
      return reply.code(200).send(toExtractionView(extraction))
    },
  )

  typed.post(
    '/extractions/:extractionId/review',
    {
      schema: {
        tags: ['extractions'],
        summary: 'Decide one extracted value',
        description:
          'Reviewers and administrators only. `verified` accepts the value as read; `correction` supplies a replacement and leaves the original untouched; `needs_review` records that the value could not be settled and requires a note. A correction identical to the recorded value is rejected, because recording a change that did not happen would misrepresent the history.',
        params: uuidParam('extractionId'),
        body: reviewExtractionBodySchema,
        response: {
          200: z.object({
            extraction: extractionSchema,
            decision: reviewDecisionSchema,
          }),
          ...errorResponses,
        },
      },
    },
    async (request, reply) => {
      const result = await reviewExtraction(app.database, {
        reviewer: actor(request),
        extractionId: request.params.extractionId,
        outcome: request.body.outcome,
        ...(request.body.correctedValue === undefined
          ? {}
          : { correctedValue: request.body.correctedValue }),
        ...(request.body.note === undefined ? {} : { note: request.body.note }),
        version: request.body.version,
        requestId: request.id,
      })

      return reply.code(200).send(result)
    },
  )

  typed.get(
    '/extractions/:extractionId/decisions',
    {
      schema: {
        tags: ['extractions'],
        summary: 'The decision history for an extracted value',
        description:
          'Oldest first. Entries are only ever appended, so the sequence shows every decision taken, including decisions that were later superseded.',
        params: uuidParam('extractionId'),
        response: {
          200: z.object({ items: z.array(reviewDecisionSchema) }),
          ...errorResponses,
        },
      },
    },
    async (request, reply) => {
      const user = actor(request)
      // Loading first applies the visibility rule through the parcel join.
      await loadVisibleExtraction(app.database, user, request.params.extractionId)

      const items = await listDecisionsForExtraction(
        app.database,
        user,
        request.params.extractionId,
      )
      return reply.code(200).send({ items })
    },
  )

  typed.get(
    '/findings/:findingId',
    {
      schema: {
        tags: ['review'],
        summary: 'Read one finding',
        description:
          'A finding is a discrepancy with an explanation, not an accusation and not a statement about ownership.',
        params: uuidParam('findingId'),
        response: {
          200: z.object({
            finding: findingSchema,
            decisions: z.array(reviewDecisionSchema),
          }),
          ...errorResponses,
        },
      },
    },
    async (request, reply) => {
      const user = actor(request)
      const detail = await loadFindingDetail(app.database, user, request.params.findingId)

      return reply.code(200).send({
        finding: toFindingView(detail.finding),
        decisions: detail.decisions,
      })
    },
  )

  typed.post(
    '/findings/:findingId/review',
    {
      schema: {
        tags: ['review'],
        summary: 'Move a finding forward',
        description:
          'Reviewers and administrators only. `under_review` marks it as being looked at; `resolved` and `dismissed` settle it and both require a reason, because a finding that disappears without one is indistinguishable from one that was made to vanish. A settled finding is never settled twice — raise a new finding if the concern returns.',
        params: uuidParam('findingId'),
        body: reviewFindingBodySchema,
        response: {
          200: z.object({
            finding: findingSchema,
            decision: reviewDecisionSchema,
          }),
          ...errorResponses,
        },
      },
    },
    async (request, reply) => {
      const result = await reviewFinding(app.database, {
        reviewer: actor(request),
        findingId: request.params.findingId,
        action: request.body.action,
        ...(request.body.reason === undefined ? {} : { reason: request.body.reason }),
        version: request.body.version,
        requestId: request.id,
      })

      return reply.code(200).send(result)
    },
  )

  typed.get(
    '/findings/:findingId/decisions',
    {
      schema: {
        tags: ['review'],
        summary: 'The decision history for a finding',
        description: 'Oldest first. Append-only.',
        params: uuidParam('findingId'),
        response: {
          200: z.object({ items: z.array(reviewDecisionSchema) }),
          ...errorResponses,
        },
      },
    },
    async (request, reply) => {
      const items = await listDecisionsForFinding(
        app.database,
        actor(request),
        request.params.findingId,
      )
      return reply.code(200).send({ items })
    },
  )
}
