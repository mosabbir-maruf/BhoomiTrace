import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'

import type { User } from '../../db/schema/users.js'
import {
  createLineageLink,
  listLineageForParcel,
  setLineageCertainty,
} from '../../services/lineage.js'
import { requireAuthenticated } from '../auth-context.js'
import {
  createLineageBodySchema,
  errorResponses,
  lineageArithmeticNoteSchema,
  lineageCertaintyBodySchema,
  lineageLinkSchema,
  lineageListSchema,
  uuidParam,
} from '../schemas.js'

/**
 * Lineage endpoints.
 *
 * A lineage link is a claim with a certainty level, not an established fact.
 * An applicant may record a link starting from a parcel they own, but only as
 * `unverified` or `illustrative`: confirming a chain is a reviewer's judgement,
 * and the confirmation is audited with the evidence it rests on. That is what
 * stops a proposed connection from quietly becoming a verified one.
 */

function actor(request: FastifyRequest): User {
  return requireAuthenticated(request).user
}

export function lineageRoutes(app: FastifyInstance): void {
  const typed = app.withTypeProvider<ZodTypeProvider>()

  typed.get(
    '/parcels/:parcelId/lineage',
    {
      schema: {
        tags: ['lineage'],
        summary: 'List lineage links for a parcel',
        description:
          'Returns links in both directions plus any arithmetic observations for split and merge relations. An observation that areas add up is a consistency note only: it does not establish legal continuity or ownership.',
        params: uuidParam('parcelId'),
        response: {
          200: lineageListSchema,
          ...errorResponses,
        },
      },
    },
    async (request, reply) => {
      const result = await listLineageForParcel(
        app.database,
        actor(request),
        request.params.parcelId,
      )
      return reply.code(200).send(result)
    },
  )

  typed.post(
    '/parcels/:parcelId/lineage',
    {
      schema: {
        tags: ['lineage'],
        summary: 'Record a lineage link',
        description:
          'Links this parcel to another visible parcel. Self-links are rejected, and a link that would close a cycle is rejected. An applicant may only start a chain from a parcel they own and may not record `confirmed`; confirming requires evidence and a reviewer.',
        params: uuidParam('parcelId'),
        body: createLineageBodySchema,
        response: {
          201: z.object({
            link: lineageLinkSchema,
            arithmetic: lineageArithmeticNoteSchema.nullable(),
          }),
          ...errorResponses,
        },
      },
    },
    async (request, reply) => {
      const result = await createLineageLink(app.database, {
        user: actor(request),
        fromParcelId: request.params.parcelId,
        toParcelId: request.body.toParcelId,
        relation: request.body.relation,
        certainty: request.body.certainty,
        ...(request.body.evidenceReference === undefined
          ? {}
          : { evidenceReference: request.body.evidenceReference }),
        ...(request.body.note === undefined ? {} : { note: request.body.note }),
        requestId: request.id,
      })

      return reply.code(201).send(result)
    },
  )

  typed.post(
    '/parcels/:parcelId/lineage/:lineageId/certainty',
    {
      schema: {
        tags: ['lineage'],
        summary: 'Change how certain a lineage link is',
        description:
          'Reviewers and administrators only. Promoting a link to `confirmed` requires an evidence reference. Because the change is a reviewer act with the previous and new state recorded, a link can never be seen to have become verified without a trace of who decided that and why.',
        params: z.object({
          parcelId: z.uuid(),
          lineageId: z.uuid(),
        }),
        body: lineageCertaintyBodySchema,
        response: {
          200: lineageLinkSchema,
          ...errorResponses,
        },
      },
    },
    async (request, reply) => {
      const link = await setLineageCertainty(app.database, {
        user: actor(request),
        parcelId: request.params.parcelId,
        lineageId: request.params.lineageId,
        certainty: request.body.certainty,
        ...(request.body.evidenceReference === undefined
          ? {}
          : { evidenceReference: request.body.evidenceReference }),
        requestId: request.id,
      })

      return reply.code(200).send(link)
    },
  )
}
