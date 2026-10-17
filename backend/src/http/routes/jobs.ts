import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'

import type { User } from '../../db/schema/users.js'
import { parsePagination } from '../../lib/pagination.js'
import { loadVisibleDocument } from '../../services/documents.js'
import { cancelJob, enqueueJob, listJobs, loadVisibleJob } from '../../services/jobs.js'
import { loadVisibleParcel } from '../../services/parcels.js'
import { requireAuthenticated } from '../auth-context.js'
import {
  enqueueJobBodySchema,
  errorResponses,
  jobListQuerySchema,
  jobSchema,
  pageOf,
  uuidParam,
} from '../schemas.js'

/**
 * Background job endpoints.
 *
 * A request that needs extraction does not do the work: it records a job and
 * returns immediately, and a separate worker process picks it up. That keeps a
 * twenty-second model call out of a request handler while the work stays durable
 * in the same database as the data it touches.
 *
 * Enqueuing validates authorization *before* recording the job: the caller must
 * be able to see the parcel, and for an extraction, the document too. A job that
 * names a record the caller cannot see is a `404`, so the queue cannot be used
 * as an oracle for other people's filings.
 *
 * `idempotencyKey` is optional. Supplying one makes a retried request return the
 * job already created instead of starting a second unit of work.
 */

function actor(request: FastifyRequest): User {
  return requireAuthenticated(request).user
}

export function jobRoutes(app: FastifyInstance): void {
  const typed = app.withTypeProvider<ZodTypeProvider>()

  typed.get(
    '/jobs',
    {
      schema: {
        tags: ['jobs'],
        summary: 'List processing jobs',
        description:
          'An applicant sees only the jobs they requested. A reviewer or administrator sees every job.',
        querystring: jobListQuerySchema,
        response: {
          200: pageOf(jobSchema),
          ...errorResponses,
        },
      },
    },
    async (request, reply) => {
      const page = await listJobs(app.database, {
        user: actor(request),
        ...(request.query.status === undefined ? {} : { status: request.query.status }),
        ...(request.query.kind === undefined ? {} : { kind: request.query.kind }),
        pagination: parsePagination(request.query),
      })

      return reply.code(200).send(page)
    },
  )

  typed.post(
    '/jobs',
    {
      schema: {
        tags: ['jobs'],
        summary: 'Queue a unit of background work',
        description:
          'The payload schema is a discriminated union on `kind`, so only the inputs that kind actually needs can be attached. A free-form payload would let a caller attach document text or a credential to an operational record.',
        body: enqueueJobBodySchema,
        response: {
          202: jobSchema,
          200: jobSchema,
          ...errorResponses,
        },
      },
    },
    async (request, reply) => {
      const user = actor(request)

      // Authorization first, and through the visibility rules, so an invisible
      // record answers exactly like a nonexistent one.
      await loadVisibleParcel(app.database, user, request.body.parcelId)

      if (request.body.kind === 'document_extraction') {
        await loadVisibleDocument(app.database, user, request.body.sourceDocumentId)
      }

      const payload =
        request.body.kind === 'document_extraction' &&
        request.body.fields !== undefined
          ? { fields: request.body.fields }
          : null

      const result = await enqueueJob(app.database, {
        requestedBy: user.id,
        kind: request.body.kind,
        parcelId: request.body.parcelId,
        sourceDocumentId:
          request.body.kind === 'document_extraction'
            ? request.body.sourceDocumentId
            : null,
        idempotencyKey: request.body.idempotencyKey ?? null,
        payload,
        maxAttempts: app.appEnv.WORKER_MAX_ATTEMPTS,
        actor: { kind: 'user', userId: user.id, role: user.role },
        requestId: request.id,
      })

      // 202 for a new job, 200 when an existing job was returned for a repeated
      // idempotency key: the caller can tell the two cases apart, and neither is
      // a silent duplicate.
      return reply.code(result.created ? 202 : 200).send(result.job)
    },
  )

  typed.get(
    '/jobs/:jobId',
    {
      schema: {
        tags: ['jobs'],
        summary: 'Read one processing job',
        description:
          'Includes attempts, the lease holder, the stored result, and a redacted failure summary. A job that a caller did not request is reported as `404`.',
        params: uuidParam('jobId'),
        response: {
          200: jobSchema,
          ...errorResponses,
        },
      },
    },
    async (request, reply) => {
      const job = await loadVisibleJob(app.database, actor(request), request.params.jobId)
      return reply.code(200).send(job)
    },
  )

  typed.post(
    '/jobs/:jobId/cancel',
    {
      schema: {
        tags: ['jobs'],
        summary: 'Cancel a job that has not been claimed',
        description:
          'Only `queued` and `retry_pending` work can be cancelled, because a claimed job is already running somewhere. Cancelling a job that was claimed in the meantime is a `409` rather than a silent no-op.',
        params: uuidParam('jobId'),
        response: {
          200: jobSchema,
          ...errorResponses,
        },
      },
    },
    async (request, reply) => {
      const job = await cancelJob(app.database, {
        user: actor(request),
        jobId: request.params.jobId,
        requestId: request.id,
      })

      return reply.code(200).send(job)
    },
  )
}
